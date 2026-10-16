import {
  canonicalStringify,
} from "../domain/canonical.js";
import type {
  Entity,
  EntityId,
  EventType,
  RuleDefinition,
  RuleEffect,
  ScheduledEvent,
  SimulationMetrics,
  SimulationRequest,
  SimulationResult,
  SimulationTrace,
  Termination,
  TraceEntry,
  WorldState,
} from "../domain/types.js";
import { validateSimulationRequest } from "../rules/validate.js";

const EVENT_PRIORITY: Record<EventType, number> = {
  collision: 10,
  damage: 20,
  "entity-created": 30,
  "heat-changed": 40,
  "gravity-changed": 50,
  "entity-destroyed": 60,
  tick: 100,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneEntity(entity: Entity): Entity {
  return { ...entity };
}

export function cloneWorldState(state: WorldState): WorldState {
  const entities: Record<string, Entity> = {};
  for (const id of Object.keys(state.entities).sort()) entities[id] = cloneEntity(state.entities[id]!);
  return { ...state, entities };
}

function cloneRequest(request: SimulationRequest): SimulationRequest {
  return {
    ...request,
    initialState: cloneWorldState(request.initialState),
    rules: request.rules.map((rule) => ({
      ...rule,
      trigger: rule.trigger.conditions === undefined ? { eventType: rule.trigger.eventType } : { eventType: rule.trigger.eventType, conditions: { ...rule.trigger.conditions } },
      effects: rule.effects.map((effect) => ({ ...effect })),
    })),
    config: { ...request.config },
  };
}

interface EventFields {
  parentEventId?: string;
  sourceRuleId?: string;
  entityId?: EntityId;
  targetEntityId?: EntityId;
  amount?: number;
  entityKind?: Entity["kind"];
  entityHealth?: number;
  entityHeat?: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

function makeEvent(sequence: number, step: number, type: EventType, fields: EventFields = {}): ScheduledEvent {
  const event: ScheduledEvent = { id: `event-${sequence}`, sequence, step, type };
  Object.assign(event, fields);
  return event;
}

function compareEvents(left: ScheduledEvent, right: ScheduledEvent): number {
  return left.step - right.step || EVENT_PRIORITY[left.type] - EVENT_PRIORITY[right.type] || left.sequence - right.sequence;
}

function entityFor(state: WorldState, id: EntityId | undefined): Entity | undefined {
  return id === undefined ? undefined : state.entities[id];
}

function matchesRule(rule: RuleDefinition, event: ScheduledEvent, state: WorldState): boolean {
  if (rule.trigger.eventType !== event.type) return false;
  const conditions = rule.trigger.conditions;
  if (conditions === undefined) return true;
  const entity = entityFor(state, event.entityId);
  const target = entityFor(state, event.targetEntityId);
  if (conditions.entityKind !== undefined && entity?.kind !== conditions.entityKind) return false;
  if (conditions.targetKind !== undefined && target?.kind !== conditions.targetKind) return false;
  if (conditions.minAmount !== undefined && (event.amount === undefined || event.amount < conditions.minAmount)) return false;
  if (conditions.maxAmount !== undefined && (event.amount === undefined || event.amount > conditions.maxAmount)) return false;
  if (conditions.minGravity !== undefined && state.gravity < conditions.minGravity) return false;
  if (conditions.maxGravity !== undefined && state.gravity > conditions.maxGravity) return false;
  const heat = entity?.heat ?? state.ambientHeat;
  if (conditions.minHeat !== undefined && heat < conditions.minHeat) return false;
  if (conditions.maxHeat !== undefined && heat > conditions.maxHeat) return false;
  return true;
}

function resolveTarget(event: ScheduledEvent, target: "entity" | "target"): EntityId | undefined {
  return target === "entity" ? event.entityId : event.targetEntityId;
}

function sourceEntity(event: ScheduledEvent, state: WorldState): Entity | undefined {
  return entityFor(state, event.entityId) ?? entityFor(state, event.targetEntityId);
}

interface AppliedEvent {
  event: ScheduledEvent;
  automaticEvents: Array<{ type: EventType; fields: EventFields }>;
  entitiesCreated: number;
  hitEntityLimit: boolean;
}

function applyEvent(event: ScheduledEvent, state: WorldState, maxEntities: number): AppliedEvent {
  const automaticEvents: Array<{ type: EventType; fields: EventFields }> = [];
  let entitiesCreated = 0;
  let hitEntityLimit = false;
  let effectiveEvent = { ...event };

  if (event.type === "damage") {
    const entity = entityFor(state, event.entityId);
    if (entity?.alive && event.amount !== undefined) {
      entity.health = Math.max(0, entity.health - event.amount);
      if (entity.health === 0) {
        automaticEvents.push({ type: "entity-destroyed", fields: { entityId: entity.id } });
      }
    }
  } else if (event.type === "entity-created") {
    if (Object.keys(state.entities).length >= maxEntities) {
      hitEntityLimit = true;
    } else if (event.entityKind !== undefined && event.entityHealth !== undefined && event.entityHeat !== undefined && event.x !== undefined && event.y !== undefined && event.vx !== undefined && event.vy !== undefined) {
      while (state.entities[`entity-${state.nextEntityNumber}`] !== undefined) state.nextEntityNumber += 1;
      const id = `entity-${state.nextEntityNumber}`;
      state.nextEntityNumber += 1;
      state.entities[id] = {
        id,
        kind: event.entityKind,
        x: event.x,
        y: event.y,
        vx: event.vx,
        vy: event.vy,
        health: event.entityHealth,
        heat: event.entityHeat,
        alive: true,
      };
      entitiesCreated = 1;
      effectiveEvent = { ...event, entityId: id };
    }
  } else if (event.type === "heat-changed") {
    if (event.entityId !== undefined && event.amount !== undefined) {
      const entity = state.entities[event.entityId];
      if (entity?.alive) entity.heat = Math.max(0, entity.heat + event.amount);
    } else if (event.amount !== undefined) {
      state.ambientHeat = Math.max(0, state.ambientHeat + event.amount);
    }
  } else if (event.type === "gravity-changed") {
    if (event.amount !== undefined) state.gravity += event.amount;
  } else if (event.type === "entity-destroyed") {
    if (event.entityId !== undefined) {
      const entity = state.entities[event.entityId];
      if (entity !== undefined) entity.alive = false;
    }
  } else if (event.type === "tick") {
    state.tick = Math.max(state.tick, event.step);
  }

  return { event: effectiveEvent, automaticEvents, entitiesCreated, hitEntityLimit };
}

function effectEvent(effect: RuleEffect, event: ScheduledEvent, state: WorldState, sequence: number): ScheduledEvent | undefined {
  const step = event.step;
  if (effect.type === "damage") {
    const entityId = resolveTarget(event, effect.target);
    return entityId === undefined ? undefined : makeEvent(sequence, step, "damage", { parentEventId: event.id, entityId, amount: effect.amount });
  }
  if (effect.type === "destroy-entity") {
    const entityId = resolveTarget(event, effect.target);
    return entityId === undefined ? undefined : makeEvent(sequence, step, "entity-destroyed", { entityId, parentEventId: event.id });
  }
  if (effect.type === "change-heat") {
    const fields: EventFields = { parentEventId: event.id, amount: effect.amount };
    if (effect.target !== "world") {
      const entityId = resolveTarget(event, effect.target);
      if (entityId === undefined) return undefined;
      fields.entityId = entityId;
    }
    return makeEvent(sequence, step, "heat-changed", fields);
  }
  if (effect.type === "change-gravity") {
    return makeEvent(sequence, step, "gravity-changed", { parentEventId: event.id, amount: effect.amount });
  }
  const source = sourceEntity(event, state);
  return makeEvent(sequence, step, "entity-created", {
    parentEventId: event.id,
    entityKind: effect.kind,
    entityHealth: effect.health,
    entityHeat: effect.heat,
    x: (source?.x ?? 0) + effect.xOffset,
    y: (source?.y ?? 0) + effect.yOffset,
    vx: effect.vx,
    vy: effect.vy,
  });
}

function initialEvents(state: WorldState): Array<{ type: EventType; fields: EventFields }> {
  const entities = Object.values(state.entities).filter((entity) => entity.alive).sort((left, right) => compareText(left.id, right.id));
  const events: Array<{ type: EventType; fields: EventFields }> = [];
  for (let leftIndex = 0; leftIndex < entities.length; leftIndex += 1) {
    const left = entities[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < entities.length; rightIndex += 1) {
      const right = entities[rightIndex]!;
      if (left.x === right.x && left.y === right.y) {
        events.push({ type: "collision", fields: { entityId: left.id, targetEntityId: right.id } });
      }
    }
  }
  return events;
}

function emptyMetrics(): SimulationMetrics {
  return { eventsProcessed: 0, eventsScheduled: 0, stepsProcessed: 0, entitiesCreated: 0, maxQueueDepth: 0 };
}

function resultFromTrace(trace: SimulationTrace): SimulationResult {
  return {
    status: trace.termination.reason === "completed" ? "completed" : "limit-exhausted",
    trace,
    finalState: cloneWorldState(trace.finalState),
    termination: trace.termination,
    metrics: { ...trace.metrics },
  };
}

/** Run a validated data-only rule set through the deterministic event engine. */
export function runSimulation(input: unknown): SimulationResult {
  const validation = validateSimulationRequest(input);
  if (!validation.ok || validation.value === undefined) return { status: "invalid-input", errors: validation.errors };
  const request = validation.value;
  const state = cloneWorldState(request.initialState);
  const queue: ScheduledEvent[] = [];
  const entries: TraceEntry[] = [];
  const metrics = emptyMetrics();
  const sortedRules = [...request.rules].sort((left, right) => compareText(left.id, right.id));
  const tickRulesExist = sortedRules.some((rule) => rule.trigger.eventType === "tick");
  let nextSequence = 1;
  let termination: Termination | undefined;
  let reachedStepLimit = false;
  let eventBudgetExhausted = false;

  const schedule = (step: number, type: EventType, fields: EventFields = {}): ScheduledEvent | undefined => {
    if (metrics.eventsScheduled >= request.config.maxEvents) {
      eventBudgetExhausted = true;
      return undefined;
    }
    const event = makeEvent(nextSequence, step, type, fields);
    nextSequence += 1;
    metrics.eventsScheduled += 1;
    queue.push(event);
    metrics.maxQueueDepth = Math.max(metrics.maxQueueDepth, queue.length);
    return event;
  };

  for (const initial of initialEvents(state)) schedule(0, initial.type, initial.fields);
  if (tickRulesExist && termination === undefined) schedule(0, "tick");

  while (queue.length > 0 && termination === undefined) {
    queue.sort(compareEvents);
    const queued = queue.shift()!;
    if (queued.step >= request.config.maxSteps) {
      termination = { reason: "max-steps", message: `The step budget of ${request.config.maxSteps} was reached` };
      break;
    }
    metrics.eventsProcessed += 1;
    metrics.stepsProcessed = Math.max(metrics.stepsProcessed, queued.step + 1);
    const before = cloneWorldState(state);
    const applied = applyEvent(queued, state, request.config.maxEntities);
    const matchingRules = sortedRules.filter((rule) => matchesRule(rule, applied.event, state));
    const appliedEffects = matchingRules.flatMap((rule) => rule.effects.map((effect) => ({ ...effect })));
    const generated: ScheduledEvent[] = [];

    for (const automatic of applied.automaticEvents) {
      const generatedEvent = schedule(queued.step, automatic.type, { ...automatic.fields, parentEventId: queued.id });
      if (generatedEvent !== undefined) generated.push(generatedEvent);
    }
    for (const rule of matchingRules) {
      for (const effect of rule.effects) {
        const generatedEvent = effectEvent(effect, applied.event, state, nextSequence);
        if (generatedEvent === undefined) continue;
        const { id: _id, sequence: _sequence, step: generatedStep, type: generatedType, ...generatedFields } = generatedEvent;
        const scheduled = schedule(generatedEvent.step, generatedEvent.type, {
          ...generatedFields,
          parentEventId: queued.id,
          sourceRuleId: rule.id,
        });
        if (scheduled !== undefined) {
          scheduled.parentEventId = queued.id;
          scheduled.sourceRuleId = rule.id;
          generated.push(scheduled);
        }
      }
    }
    if (applied.event.type === "tick") {
      if (applied.event.step + 1 < request.config.maxSteps && tickRulesExist && termination === undefined) {
        const nextTick = schedule(applied.event.step + 1, "tick", { parentEventId: applied.event.id });
        if (nextTick !== undefined) generated.push(nextTick);
      } else if (tickRulesExist && applied.event.step + 1 >= request.config.maxSteps) {
        reachedStepLimit = true;
      }
    }

    const after = cloneWorldState(state);
    entries.push({
      event: applied.event,
      stateBefore: before,
      matchedRuleIds: matchingRules.map((rule) => rule.id),
      appliedEffects,
      scheduledEvents: generated.map((event) => ({ ...event })),
      stateAfter: after,
    });
    metrics.entitiesCreated += applied.entitiesCreated;
    if (applied.hitEntityLimit) {
      termination = { reason: "max-entities", message: `The entity budget of ${request.config.maxEntities} was reached` };
    }
  }

  if (termination === undefined) {
    termination = eventBudgetExhausted
      ? { reason: "max-events", message: `The event budget of ${request.config.maxEvents} was exhausted before all possible events could be scheduled` }
      : reachedStepLimit
      ? { reason: "max-steps", message: `The step budget of ${request.config.maxSteps} was reached` }
      : { reason: "completed", message: "The event queue was exhausted" };
  }

  const trace: SimulationTrace = {
    traceSchemaVersion: 1,
    engineVersion: request.engineVersion,
    seed: request.seed,
    request: cloneRequest(request),
    entries,
    finalState: cloneWorldState(state),
    termination,
    metrics: { ...metrics },
  };
  // This call deliberately exercises the canonical serializer at the engine boundary.
  // It also makes malformed future state additions fail deterministically rather than
  // being silently ignored by a JSON consumer.
  canonicalStringify(trace.finalState);
  return resultFromTrace(trace);
}
