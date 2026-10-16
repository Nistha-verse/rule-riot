export const TRACE_SCHEMA_VERSION = 1 as const;
export const REQUEST_SCHEMA_VERSION = 1 as const;

export type EntityId = string;
export type EntityKind = "core" | "fragment" | "thermal";

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  health: number;
  heat: number;
  alive: boolean;
}

export interface WorldState {
  tick: number;
  gravity: number;
  ambientHeat: number;
  nextEntityNumber: number;
  entities: Record<EntityId, Entity>;
}

export type EventType =
  | "collision"
  | "damage"
  | "entity-created"
  | "heat-changed"
  | "gravity-changed"
  | "entity-destroyed"
  | "tick";

export interface RuleConditions {
  entityKind?: EntityKind;
  targetKind?: EntityKind;
  minAmount?: number;
  maxAmount?: number;
  minGravity?: number;
  maxGravity?: number;
  minHeat?: number;
  maxHeat?: number;
}

export interface RuleTrigger {
  eventType: EventType;
  conditions?: RuleConditions;
}

export type EffectTarget = "entity" | "target" | "world";

export interface DamageEffect {
  type: "damage";
  target: Exclude<EffectTarget, "world">;
  amount: number;
}

export interface CreateEntityEffect {
  type: "create-entity";
  kind: EntityKind;
  health: number;
  heat: number;
  xOffset: number;
  yOffset: number;
  vx: number;
  vy: number;
}

export interface HeatEffect {
  type: "change-heat";
  target: EffectTarget;
  amount: number;
}

export interface GravityEffect {
  type: "change-gravity";
  amount: number;
}

export interface DestroyEffect {
  type: "destroy-entity";
  target: Exclude<EffectTarget, "world">;
}

export type RuleEffect =
  | DamageEffect
  | CreateEntityEffect
  | HeatEffect
  | GravityEffect
  | DestroyEffect;

export interface RuleDefinition {
  id: string;
  name: string;
  trigger: RuleTrigger;
  effects: RuleEffect[];
}

export interface SimulationConfig {
  maxSteps: number;
  maxEvents: number;
  maxEntities: number;
}

export interface SimulationRequest {
  schemaVersion: typeof REQUEST_SCHEMA_VERSION;
  engineVersion: string;
  seed: string;
  initialState: WorldState;
  rules: RuleDefinition[];
  config: SimulationConfig;
}

export interface ScheduledEvent {
  id: string;
  sequence: number;
  step: number;
  type: EventType;
  parentEventId?: string;
  sourceRuleId?: string;
  entityId?: EntityId;
  targetEntityId?: EntityId;
  amount?: number;
  entityKind?: EntityKind;
  entityHealth?: number;
  entityHeat?: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

export type TerminationReason =
  | "completed"
  | "max-steps"
  | "max-events"
  | "max-entities";

export interface Termination {
  reason: TerminationReason;
  message: string;
}

export interface SimulationMetrics {
  eventsProcessed: number;
  eventsScheduled: number;
  stepsProcessed: number;
  entitiesCreated: number;
  maxQueueDepth: number;
}

export interface TraceEntry {
  event: ScheduledEvent;
  stateBefore: WorldState;
  matchedRuleIds: string[];
  appliedEffects: RuleEffect[];
  scheduledEvents: ScheduledEvent[];
  stateAfter: WorldState;
}

export interface SimulationTrace {
  traceSchemaVersion: typeof TRACE_SCHEMA_VERSION;
  engineVersion: string;
  seed: string;
  request: SimulationRequest;
  entries: TraceEntry[];
  finalState: WorldState;
  termination: Termination;
  metrics: SimulationMetrics;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type InvalidSimulationResult = {
  status: "invalid-input";
  errors: ValidationIssue[];
};

export type ValidSimulationResult = {
  status: "completed" | "limit-exhausted";
  trace: SimulationTrace;
  finalState: WorldState;
  termination: Termination;
  metrics: SimulationMetrics;
};

export type SimulationResult = InvalidSimulationResult | ValidSimulationResult;
