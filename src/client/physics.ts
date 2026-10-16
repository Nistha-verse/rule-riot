import RAPIER from "@dimforge/rapier2d-compat";
import type { EntityKind, RuleDefinition } from "../domain/types.js";

export interface ArenaEntity {
  id: string;
  kind: EntityKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  health: number;
  heat: number;
  alive: boolean;
}

export interface ArenaSnapshot {
  step: number;
  gravity: number;
  ambientHeat: number;
  entities: ArenaEntity[];
  lastEvent: LocalEvent | null;
}

export type LocalEventType = "collision" | "damage" | "entity-created" | "heat-changed" | "gravity-changed" | "entity-destroyed";

export interface LocalEvent {
  id: string;
  type: LocalEventType;
  parentEventId?: string;
  sourceRuleId?: string;
  entityId?: string;
  targetEntityId?: string;
  amount?: number;
  label: string;
}

interface BodyMeta {
  id: string;
  kind: EntityKind;
  health: number;
  heat: number;
  colliderHandle: number;
  body: RAPIER.RigidBody;
}

const FIXED_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;
const MAX_LOCAL_EVENTS = 180;
const WORLD_WIDTH = 14;
const WORLD_HEIGHT = 8;

export class PhysicsArena {
  readonly ready: Promise<void>;
  private world: RAPIER.World | null = null;
  private queue: RAPIER.EventQueue | null = null;
  private bodies = new Map<number, BodyMeta>();
  private entities = new Map<string, BodyMeta>();
  private rules: RuleDefinition[] = [];
  private updateHandlers = new Set<(snapshot: ArenaSnapshot) => void>();
  private running = false;
  private raf = 0;
  private accumulator = 0;
  private previousTime = 0;
  private stepNumber = 0;
  private nextEntityNumber = 1;
  private nextEventNumber = 1;
  private ambientHeat = 0;
  private gravity = 1;
  private lastEvent: LocalEvent | null = null;

  constructor(onUpdate?: (snapshot: ArenaSnapshot) => void) {
    if (onUpdate !== undefined) this.updateHandlers.add(onUpdate);
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    await RAPIER.init();
    this.reset();
  }

  setUpdateHandler(handler: (snapshot: ArenaSnapshot) => void): void {
    this.updateHandlers.clear();
    this.updateHandlers.add(handler);
  }

  addUpdateHandler(handler: (snapshot: ArenaSnapshot) => void): void {
    this.updateHandlers.add(handler);
  }

  setRules(rules: RuleDefinition[]): void {
    this.rules = rules.map((rule) => ({ ...rule, effects: rule.effects.map((effect) => ({ ...effect })) }));
  }

  reset(): void {
    if (this.world !== null) this.world.free();
    this.world = new RAPIER.World({ x: 0, y: 1 });
    this.queue = new RAPIER.EventQueue(true);
    this.bodies.clear();
    this.entities.clear();
    this.gravity = 1;
    this.ambientHeat = 0;
    this.stepNumber = 0;
    this.nextEntityNumber = 1;
    this.nextEventNumber = 1;
    this.lastEvent = null;
    this.addBoundaries();
    this.addEntity("alpha", "core", -2.5, -1.5, 1.8, 0, 100, 0);
    this.addEntity("beta", "core", 2.5, -1.5, -1.8, 0, 100, 0);
    this.addEntity("anchor", "thermal", 0, 1.8, 0, 0, 80, 12);
    this.emit();
  }

  start(): void {
    if (this.running) return;
    if (typeof requestAnimationFrame !== "function") throw new Error("The live arena requires a browser animation frame loop");
    this.running = true;
    this.previousTime = performance.now();
    this.raf = requestAnimationFrame((time) => this.frame(time));
  }

  pause(): void {
    this.running = false;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf);
  }

  toggle(): boolean {
    if (this.running) this.pause();
    else this.start();
    return this.running;
  }

  isRunning(): boolean {
    return this.running;
  }

  stepOnce(): void {
    this.pause();
    this.advance(FIXED_STEP);
    this.emit();
  }

  impulse(): void {
    const targets = [...this.entities.values()].filter((entity) => entity.kind === "core");
    for (const [index, target] of targets.entries()) target.body.applyImpulse({ x: index === 0 ? -1.8 : 1.8, y: -1.2 }, true);
  }

  snapshot(): ArenaSnapshot {
    return {
      step: this.stepNumber,
      gravity: this.gravity,
      ambientHeat: this.ambientHeat,
      entities: [...this.entities.values()].map((meta) => {
        const position = meta.body.translation();
        const velocity = meta.body.linvel();
        return { id: meta.id, kind: meta.kind, x: position.x, y: position.y, vx: velocity.x, vy: velocity.y, health: meta.health, heat: meta.heat, alive: meta.body.isValid() };
      }),
      lastEvent: this.lastEvent,
    };
  }

  dispose(): void {
    this.pause();
    this.queue?.free();
    this.queue = null;
    this.world?.free();
    this.world = null;
  }

  private frame(time: number): void {
    if (!this.running) return;
    const elapsed = Math.min(0.1, (time - this.previousTime) / 1000);
    this.previousTime = time;
    this.accumulator += elapsed;
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.advance(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps += 1;
    }
    this.emit();
    this.raf = requestAnimationFrame((next) => this.frame(next));
  }

  private advance(_delta: number): void {
    if (this.world === null || this.queue === null) return;
    this.world.gravity = { x: 0, y: this.gravity };
    this.world.step(this.queue);
    this.queue.drainCollisionEvents((handle1, handle2, started) => {
      if (!started) return;
      const first = this.bodies.get(handle1);
      const second = this.bodies.get(handle2);
      if (first === undefined || second === undefined) return;
      this.processEvent({ id: this.eventId(), type: "collision", entityId: first.id, targetEntityId: second.id, label: `${first.id} met ${second.id}` });
    });
    this.stepNumber += 1;
  }

  private processEvent(initial: LocalEvent): void {
    const queue: LocalEvent[] = [initial];
    let processed = 0;
    while (queue.length > 0 && processed < MAX_LOCAL_EVENTS) {
      const event = queue.shift()!;
      processed += 1;
      this.lastEvent = event;
      const matching = this.rules.filter((rule) => this.matches(rule, event));
      for (const rule of matching) {
        for (const effect of rule.effects) {
          const generated = this.applyEffect(effect, event);
          if (generated !== undefined) {
            generated.parentEventId = event.id;
            generated.sourceRuleId = rule.id;
            queue.push(generated);
          }
        }
      }
    }
  }

  private matches(rule: RuleDefinition, event: LocalEvent): boolean {
    if (rule.trigger.eventType !== event.type) return false;
    const conditions = rule.trigger.conditions;
    if (conditions === undefined) return true;
    const entity = event.entityId === undefined ? undefined : this.entities.get(event.entityId);
    const target = event.targetEntityId === undefined ? undefined : this.entities.get(event.targetEntityId);
    if (conditions.entityKind !== undefined && entity?.kind !== conditions.entityKind) return false;
    if (conditions.targetKind !== undefined && target?.kind !== conditions.targetKind) return false;
    if (conditions.minAmount !== undefined && (event.amount === undefined || event.amount < conditions.minAmount)) return false;
    if (conditions.maxAmount !== undefined && (event.amount === undefined || event.amount > conditions.maxAmount)) return false;
    if (conditions.minGravity !== undefined && this.gravity < conditions.minGravity) return false;
    if (conditions.maxGravity !== undefined && this.gravity > conditions.maxGravity) return false;
    return true;
  }

  private applyEffect(effect: RuleDefinition["effects"][number], event: LocalEvent): LocalEvent | undefined {
    if (effect.type === "damage") {
      const id = effect.target === "entity" ? event.entityId : event.targetEntityId;
      const target = id === undefined ? undefined : this.entities.get(id);
      if (target === undefined) return undefined;
      target.health = Math.max(0, target.health - effect.amount);
      if (target.health === 0) {
        return { id: this.eventId(), type: "entity-destroyed", entityId: target.id, label: `${target.id} broke apart` };
      }
      return { id: this.eventId(), type: "damage", entityId: target.id, amount: effect.amount, label: `${target.id} took ${effect.amount} damage` };
    }
    if (effect.type === "create-entity") {
      const sourceId = event.entityId ?? event.targetEntityId;
      const source = sourceId === undefined ? undefined : this.entities.get(sourceId);
      const position = source?.body.translation() ?? { x: 0, y: 0 };
      const id = `entity-${this.nextEntityNumber++}`;
      if (!this.addEntity(id, effect.kind, position.x + effect.xOffset, position.y + effect.yOffset, effect.vx, effect.vy, effect.health, effect.heat)) return undefined;
      return { id: this.eventId(), type: "entity-created", entityId: id, label: `${id} entered the arena` };
    }
    if (effect.type === "change-heat") {
      if (effect.target === "world") this.ambientHeat = Math.max(0, this.ambientHeat + effect.amount);
      else {
        const id = effect.target === "entity" ? event.entityId : event.targetEntityId;
        const target = id === undefined ? undefined : this.entities.get(id);
        if (target !== undefined) target.heat = Math.max(0, target.heat + effect.amount);
      }
      const generated: LocalEvent = { id: this.eventId(), type: "heat-changed", amount: effect.amount, label: `Heat shifted by ${effect.amount}` };
      if (event.entityId !== undefined) generated.entityId = event.entityId;
      return generated;
    }
    if (effect.type === "change-gravity") {
      this.gravity += effect.amount;
      return { id: this.eventId(), type: "gravity-changed", amount: effect.amount, label: `Gravity is now ${this.gravity.toFixed(1)}` };
    }
    const id = effect.target === "entity" ? event.entityId : event.targetEntityId;
    if (id !== undefined) this.removeEntity(id);
    const generated: LocalEvent = { id: this.eventId(), type: "entity-destroyed", label: `${id ?? "An object"} was removed` };
    if (id !== undefined) generated.entityId = id;
    return generated;
  }

  private eventId(): string {
    return `physics-${this.nextEventNumber++}`;
  }

  private addBoundaries(): void {
    if (this.world === null) return;
    const floor = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, WORLD_HEIGHT / 2));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(WORLD_WIDTH / 2, 0.18).setRestitution(0.55), floor);
    const ceiling = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -WORLD_HEIGHT / 2));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(WORLD_WIDTH / 2, 0.18).setRestitution(0.55), ceiling);
    const left = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-WORLD_WIDTH / 2, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.18, WORLD_HEIGHT / 2).setRestitution(0.55), left);
    const right = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(WORLD_WIDTH / 2, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.18, WORLD_HEIGHT / 2).setRestitution(0.55), right);
  }

  private addEntity(id: string, kind: EntityKind, x: number, y: number, vx: number, vy: number, health: number, heat: number): boolean {
    if (this.world === null || this.entities.size >= 32) return false;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setLinvel(vx, vy).setLinearDamping(0.05));
    const radius = kind === "core" ? 0.48 : kind === "thermal" ? 0.62 : 0.28;
    const collider = this.world.createCollider(RAPIER.ColliderDesc.ball(radius).setRestitution(0.78).setFriction(0.28).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body);
    const meta: BodyMeta = { id, kind, health, heat, colliderHandle: collider.handle, body };
    this.bodies.set(collider.handle, meta);
    this.entities.set(id, meta);
    return true;
  }

  private removeEntity(id: string): void {
    const target = this.entities.get(id);
    if (target === undefined || this.world === null) return;
    this.bodies.delete(target.colliderHandle);
    this.entities.delete(id);
    this.world.removeRigidBody(target.body);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const handler of this.updateHandlers) handler(snapshot);
  }
}

export { FIXED_STEP, WORLD_HEIGHT, WORLD_WIDTH };
