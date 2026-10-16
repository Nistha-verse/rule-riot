import { ENGINE_VERSION } from "../version.js";
import {
  REQUEST_SCHEMA_VERSION,
  type CreateEntityEffect,
  type Entity,
  type RuleConditions,
  type RuleDefinition,
  type RuleEffect,
  type RuleTrigger,
  type SimulationConfig,
  type SimulationRequest,
  type ValidationIssue,
  type WorldState,
} from "../domain/types.js";
import { SUPPORTED_EFFECT_TARGETS, SUPPORTED_EFFECT_TYPES, SUPPORTED_ENTITY_KINDS, SUPPORTED_EVENT_TYPES } from "./vocabulary.js";

const RULE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENTITY_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_ABSOLUTE_NUMBER = 1_000_000_000;

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: ValidationIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(errors: ValidationIssue[], path: string, message: string): void {
  errors.push({ path, message });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: ValidationIssue[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issue(errors, `${path}.${key}`, "unknown field");
    }
  }
}

function stringValue(value: unknown, path: string, errors: ValidationIssue[], minLength = 1, maxLength = 256): string | undefined {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
    issue(errors, path, `must be a string with ${minLength}-${maxLength} characters`);
    return undefined;
  }
  return value;
}

function finiteNumber(value: unknown, path: string, errors: ValidationIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_ABSOLUTE_NUMBER) {
    issue(errors, path, `must be finite and have an absolute value of at most ${MAX_ABSOLUTE_NUMBER}`);
    return undefined;
  }
  return value;
}

function integer(value: unknown, path: string, errors: ValidationIssue[], minimum: number, maximum: number): number | undefined {
  const number = finiteNumber(value, path, errors);
  if (number === undefined) return undefined;
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    issue(errors, path, `must be an integer between ${minimum} and ${maximum}`);
    return undefined;
  }
  return number;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string, errors: ValidationIssue[]): T | undefined {
  if (typeof value !== "string" || !values.includes(value as T)) {
    issue(errors, path, `must be one of: ${values.join(", ")}`);
    return undefined;
  }
  return value as T;
}

function validateConditions(value: unknown, path: string, errors: ValidationIssue[]): RuleConditions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issue(errors, path, "must be an object");
    return undefined;
  }
  hasOnlyKeys(value, ["entityKind", "targetKind", "minAmount", "maxAmount", "minGravity", "maxGravity", "minHeat", "maxHeat"], path, errors);
  const entityKind = value.entityKind === undefined ? undefined : enumValue(value.entityKind, SUPPORTED_ENTITY_KINDS, `${path}.entityKind`, errors);
  const targetKind = value.targetKind === undefined ? undefined : enumValue(value.targetKind, SUPPORTED_ENTITY_KINDS, `${path}.targetKind`, errors);
  const minAmount = value.minAmount === undefined ? undefined : finiteNumber(value.minAmount, `${path}.minAmount`, errors);
  const maxAmount = value.maxAmount === undefined ? undefined : finiteNumber(value.maxAmount, `${path}.maxAmount`, errors);
  const minGravity = value.minGravity === undefined ? undefined : finiteNumber(value.minGravity, `${path}.minGravity`, errors);
  const maxGravity = value.maxGravity === undefined ? undefined : finiteNumber(value.maxGravity, `${path}.maxGravity`, errors);
  const minHeat = value.minHeat === undefined ? undefined : finiteNumber(value.minHeat, `${path}.minHeat`, errors);
  const maxHeat = value.maxHeat === undefined ? undefined : finiteNumber(value.maxHeat, `${path}.maxHeat`, errors);

  if (minAmount !== undefined && maxAmount !== undefined && minAmount > maxAmount) issue(errors, path, "minAmount cannot exceed maxAmount");
  if (minGravity !== undefined && maxGravity !== undefined && minGravity > maxGravity) issue(errors, path, "minGravity cannot exceed maxGravity");
  if (minHeat !== undefined && maxHeat !== undefined && minHeat > maxHeat) issue(errors, path, "minHeat cannot exceed maxHeat");

  const conditions: RuleConditions = {};
  if (entityKind !== undefined) conditions.entityKind = entityKind;
  if (targetKind !== undefined) conditions.targetKind = targetKind;
  if (minAmount !== undefined) conditions.minAmount = minAmount;
  if (maxAmount !== undefined) conditions.maxAmount = maxAmount;
  if (minGravity !== undefined) conditions.minGravity = minGravity;
  if (maxGravity !== undefined) conditions.maxGravity = maxGravity;
  if (minHeat !== undefined) conditions.minHeat = minHeat;
  if (maxHeat !== undefined) conditions.maxHeat = maxHeat;
  return Object.keys(conditions).length === 0 ? undefined : conditions;
}

function validateEffect(value: unknown, path: string, errors: ValidationIssue[]): RuleEffect | undefined {
  if (!isRecord(value)) {
    issue(errors, path, "must be an object");
    return undefined;
  }
  const type = enumValue(value.type, SUPPORTED_EFFECT_TYPES, `${path}.type`, errors);
  if (type === undefined) return undefined;

  if (type === "damage") {
    hasOnlyKeys(value, ["type", "target", "amount"], path, errors);
    const target = enumValue(value.target, ["entity", "target"], `${path}.target`, errors);
    const amount = finiteNumber(value.amount, `${path}.amount`, errors);
    if (amount !== undefined && amount <= 0) issue(errors, `${path}.amount`, "must be greater than zero");
    return target !== undefined && amount !== undefined && amount > 0 ? { type, target, amount } : undefined;
  }

  if (type === "create-entity") {
    hasOnlyKeys(value, ["type", "kind", "health", "heat", "xOffset", "yOffset", "vx", "vy"], path, errors);
    const kind = enumValue(value.kind, SUPPORTED_ENTITY_KINDS, `${path}.kind`, errors);
    const health = finiteNumber(value.health, `${path}.health`, errors);
    const heat = finiteNumber(value.heat, `${path}.heat`, errors);
    const xOffset = finiteNumber(value.xOffset, `${path}.xOffset`, errors);
    const yOffset = finiteNumber(value.yOffset, `${path}.yOffset`, errors);
    const vx = finiteNumber(value.vx, `${path}.vx`, errors);
    const vy = finiteNumber(value.vy, `${path}.vy`, errors);
    if (health !== undefined && health <= 0) issue(errors, `${path}.health`, "must be greater than zero");
    if (heat !== undefined && heat < 0) issue(errors, `${path}.heat`, "must not be negative");
    if (kind === undefined || health === undefined || heat === undefined || xOffset === undefined || yOffset === undefined || vx === undefined || vy === undefined || health <= 0 || heat < 0) return undefined;
    const result: CreateEntityEffect = { type, kind, health, heat, xOffset, yOffset, vx, vy };
    return result;
  }

  if (type === "change-heat") {
    hasOnlyKeys(value, ["type", "target", "amount"], path, errors);
    const target = enumValue(value.target, SUPPORTED_EFFECT_TARGETS, `${path}.target`, errors);
    const amount = finiteNumber(value.amount, `${path}.amount`, errors);
    if (amount !== undefined && amount === 0) issue(errors, `${path}.amount`, "must not be zero");
    return target !== undefined && amount !== undefined && amount !== 0 ? { type, target, amount } : undefined;
  }

  if (type === "change-gravity") {
    hasOnlyKeys(value, ["type", "amount"], path, errors);
    const amount = finiteNumber(value.amount, `${path}.amount`, errors);
    if (amount !== undefined && amount === 0) issue(errors, `${path}.amount`, "must not be zero");
    return amount !== undefined && amount !== 0 ? { type, amount } : undefined;
  }

  hasOnlyKeys(value, ["type", "target"], path, errors);
  const target = enumValue(value.target, ["entity", "target"], `${path}.target`, errors);
  return target === undefined ? undefined : { type, target };
}

export function validateRule(value: unknown, path = "rule"): ValidationResult<RuleDefinition> {
  const errors: ValidationIssue[] = [];
  if (!isRecord(value)) return { ok: false, errors: [{ path, message: "must be an object" }] };
  hasOnlyKeys(value, ["id", "name", "trigger", "effects"], path, errors);
  const id = stringValue(value.id, `${path}.id`, errors, 1, 64);
  if (id !== undefined && !RULE_ID.test(id)) issue(errors, `${path}.id`, "must match ^[a-z][a-z0-9-]{0,63}$");
  const name = stringValue(value.name, `${path}.name`, errors, 1, 120);

  let trigger: RuleTrigger | undefined;
  if (!isRecord(value.trigger)) {
    issue(errors, `${path}.trigger`, "must be an object");
  } else {
    hasOnlyKeys(value.trigger, ["eventType", "conditions"], `${path}.trigger`, errors);
    const eventType = enumValue(value.trigger.eventType, SUPPORTED_EVENT_TYPES, `${path}.trigger.eventType`, errors);
    const conditions = validateConditions(value.trigger.conditions, `${path}.trigger.conditions`, errors);
    if (eventType !== undefined) {
      trigger = conditions === undefined ? { eventType } : { eventType, conditions };
    }
  }

  const effectsInput = Array.isArray(value.effects) ? value.effects : undefined;
  let effects: RuleEffect[] | undefined;
  if (effectsInput === undefined || effectsInput.length < 1 || effectsInput.length > 8) {
    issue(errors, `${path}.effects`, "must contain between 1 and 8 effects");
  } else {
    effects = effectsInput.flatMap((effect, index) => {
      const validated = validateEffect(effect, `${path}.effects[${index}]`, errors);
      return validated === undefined ? [] : [validated];
    });
  }

  if (errors.length > 0 || id === undefined || name === undefined || trigger === undefined || effects === undefined || effects.length !== effectsInput?.length) {
    return { ok: false, errors };
  }
  return { ok: true, value: { id, name, trigger, effects }, errors: [] };
}

export function validateRuleSet(value: unknown, path = "rules"): ValidationResult<RuleDefinition[]> {
  const errors: ValidationIssue[] = [];
  if (!Array.isArray(value) || value.length > 128) {
    return { ok: false, errors: [{ path, message: "must be an array with at most 128 rules" }] };
  }
  const rules: RuleDefinition[] = [];
  const ids = new Set<string>();
  value.forEach((rule, index) => {
    const result = validateRule(rule, `${path}[${index}]`);
    errors.push(...result.errors);
    if (result.value !== undefined) {
      if (ids.has(result.value.id)) issue(errors, `${path}[${index}].id`, "duplicate rule id");
      ids.add(result.value.id);
      rules.push(result.value);
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: rules, errors: [] };
}

function validateEntity(value: unknown, path: string, expectedId: string, errors: ValidationIssue[]): Entity | undefined {
  if (!isRecord(value)) {
    issue(errors, path, "must be an object");
    return undefined;
  }
  hasOnlyKeys(value, ["id", "kind", "x", "y", "vx", "vy", "health", "heat", "alive"], path, errors);
  const id = stringValue(value.id, `${path}.id`, errors, 1, 64);
  if (id !== expectedId) issue(errors, `${path}.id`, "must match its entity map key");
  if (id !== undefined && !ENTITY_ID.test(id)) issue(errors, `${path}.id`, "contains invalid characters");
  const kind = enumValue(value.kind, SUPPORTED_ENTITY_KINDS, `${path}.kind`, errors);
  const x = finiteNumber(value.x, `${path}.x`, errors);
  const y = finiteNumber(value.y, `${path}.y`, errors);
  const vx = finiteNumber(value.vx, `${path}.vx`, errors);
  const vy = finiteNumber(value.vy, `${path}.vy`, errors);
  const health = finiteNumber(value.health, `${path}.health`, errors);
  const heat = finiteNumber(value.heat, `${path}.heat`, errors);
  if (health !== undefined && health < 0) issue(errors, `${path}.health`, "must not be negative");
  if (heat !== undefined && heat < 0) issue(errors, `${path}.heat`, "must not be negative");
  if (typeof value.alive !== "boolean") issue(errors, `${path}.alive`, "must be a boolean");
  if (id === undefined || kind === undefined || x === undefined || y === undefined || vx === undefined || vy === undefined || health === undefined || heat === undefined || typeof value.alive !== "boolean" || health < 0 || heat < 0) return undefined;
  return { id, kind, x, y, vx, vy, health, heat, alive: value.alive };
}

function validateWorldState(value: unknown, path: string, errors: ValidationIssue[]): WorldState | undefined {
  if (!isRecord(value)) {
    issue(errors, path, "must be an object");
    return undefined;
  }
  hasOnlyKeys(value, ["tick", "gravity", "ambientHeat", "nextEntityNumber", "entities"], path, errors);
  const tick = integer(value.tick, `${path}.tick`, errors, 0, 10_000_000);
  const gravity = finiteNumber(value.gravity, `${path}.gravity`, errors);
  const ambientHeat = finiteNumber(value.ambientHeat, `${path}.ambientHeat`, errors);
  if (ambientHeat !== undefined && ambientHeat < 0) issue(errors, `${path}.ambientHeat`, "must not be negative");
  const nextEntityNumber = integer(value.nextEntityNumber, `${path}.nextEntityNumber`, errors, 1, 10_000_000);
  const entities: Record<string, Entity> = {};
  if (!isRecord(value.entities)) {
    issue(errors, `${path}.entities`, "must be an object");
  } else {
    for (const id of Object.keys(value.entities).sort()) {
      const entity = validateEntity(value.entities[id], `${path}.entities.${id}`, id, errors);
      if (entity !== undefined) entities[id] = entity;
    }
  }
  if (tick === undefined || gravity === undefined || ambientHeat === undefined || nextEntityNumber === undefined) return undefined;
  return { tick, gravity, ambientHeat, nextEntityNumber, entities };
}

function validateConfig(value: unknown, path: string, entityCount: number, errors: ValidationIssue[]): SimulationConfig | undefined {
  if (!isRecord(value)) {
    issue(errors, path, "must be an object");
    return undefined;
  }
  hasOnlyKeys(value, ["maxSteps", "maxEvents", "maxEntities"], path, errors);
  const maxSteps = integer(value.maxSteps, `${path}.maxSteps`, errors, 1, 1_000_000);
  const maxEvents = integer(value.maxEvents, `${path}.maxEvents`, errors, 1, 10_000_000);
  const maxEntities = integer(value.maxEntities, `${path}.maxEntities`, errors, 1, 1_000_000);
  if (maxEntities !== undefined && maxEntities < entityCount) issue(errors, `${path}.maxEntities`, "cannot be lower than the initial entity count");
  if (maxSteps === undefined || maxEvents === undefined || maxEntities === undefined) return undefined;
  return { maxSteps, maxEvents, maxEntities };
}

export function validateSimulationRequest(value: unknown): ValidationResult<SimulationRequest> {
  const errors: ValidationIssue[] = [];
  if (!isRecord(value)) return { ok: false, errors: [{ path: "request", message: "must be an object" }] };
  hasOnlyKeys(value, ["schemaVersion", "engineVersion", "seed", "initialState", "rules", "config"], "request", errors);
  if (value.schemaVersion !== REQUEST_SCHEMA_VERSION) issue(errors, "request.schemaVersion", `must be ${REQUEST_SCHEMA_VERSION}`);
  const engineVersion = stringValue(value.engineVersion, "request.engineVersion", errors, 1, 64);
  if (engineVersion !== undefined && engineVersion !== ENGINE_VERSION) issue(errors, "request.engineVersion", `must match engine version ${ENGINE_VERSION}`);
  const seed = stringValue(value.seed, "request.seed", errors, 1, 256);
  const initialState = validateWorldState(value.initialState, "request.initialState", errors);
  const ruleResult = validateRuleSet(value.rules, "request.rules");
  errors.push(...ruleResult.errors);
  const config = validateConfig(value.config, "request.config", initialState === undefined ? 0 : Object.keys(initialState.entities).length, errors);
  if (errors.length > 0 || engineVersion === undefined || seed === undefined || initialState === undefined || !ruleResult.value || config === undefined) {
    return { ok: false, errors };
  }
  return { ok: true, value: { schemaVersion: REQUEST_SCHEMA_VERSION, engineVersion, seed, initialState, rules: ruleResult.value, config }, errors: [] };
}
