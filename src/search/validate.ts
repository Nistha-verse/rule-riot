import { ENGINE_VERSION } from "../version.js";
import { validateRuleSet, validateSimulationRequest } from "../rules/validate.js";
import type { ValidationIssue } from "../domain/types.js";
import type {
  ChainReactionObjective,
  GravityCondition,
  RuleCountConstraints,
  SearchBudget,
  SearchRequest,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, path: string, errors: ValidationIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ path, message: "must be a finite number" });
    return undefined;
  }
  return value;
}

function integer(value: unknown, path: string, errors: ValidationIssue[], min: number, max: number): number | undefined {
  const number = finiteNumber(value, path, errors);
  if (number === undefined || !Number.isInteger(number) || number < min || number > max) {
    if (number !== undefined) errors.push({ path, message: `must be an integer between ${min} and ${max}` });
    return undefined;
  }
  return number;
}

function stringValue(value: unknown, path: string, errors: ValidationIssue[]): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    errors.push({ path, message: "must be a non-empty string of at most 256 characters" });
    return undefined;
  }
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: ValidationIssue[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) errors.push({ path: `${path}.${key}`, message: "unknown field" });
}

export function validateSearchRequest(value: unknown): { ok: true; value: SearchRequest; errors: [] } | { ok: false; errors: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  if (!isRecord(value)) return { ok: false, errors: [{ path: "request", message: "must be an object" }] };
  onlyKeys(value, ["schemaVersion", "engineVersion", "seed", "initialState", "availableRules", "constraints", "objective", "budget", "simulationConfig"], "request", errors);
  if (value.schemaVersion !== 1) errors.push({ path: "request.schemaVersion", message: "must be 1" });
  const engineVersion = stringValue(value.engineVersion, "request.engineVersion", errors);
  if (engineVersion !== undefined && engineVersion !== ENGINE_VERSION) errors.push({ path: "request.engineVersion", message: `must match engine version ${ENGINE_VERSION}` });
  const seed = stringValue(value.seed, "request.seed", errors);
  const rulesResult = validateRuleSet(value.availableRules, "request.availableRules");
  errors.push(...rulesResult.errors);

  let constraints: RuleCountConstraints | undefined;
  if (!isRecord(value.constraints)) {
    errors.push({ path: "request.constraints", message: "must be an object" });
  } else {
    onlyKeys(value.constraints, ["minRules", "maxRules"], "request.constraints", errors);
    const minRules = integer(value.constraints.minRules, "request.constraints.minRules", errors, 0, 128);
    const maxRules = integer(value.constraints.maxRules, "request.constraints.maxRules", errors, 0, 128);
    if (minRules !== undefined && maxRules !== undefined && minRules > maxRules) errors.push({ path: "request.constraints", message: "minRules cannot exceed maxRules" });
    if (maxRules !== undefined && rulesResult.value !== undefined && maxRules > rulesResult.value.length) errors.push({ path: "request.constraints.maxRules", message: "cannot exceed available rule count" });
    if (minRules !== undefined && maxRules !== undefined) constraints = { minRules, maxRules };
  }

  let objective: ChainReactionObjective | undefined;
  if (!isRecord(value.objective)) {
    errors.push({ path: "request.objective", message: "must be an object" });
  } else {
    onlyKeys(value.objective, ["type", "minCausalEvents", "minEntitiesCreated", "gravity", "requireCompleted"], "request.objective", errors);
    if (value.objective.type !== "causal-chain") errors.push({ path: "request.objective.type", message: "must be causal-chain" });
    const minCausalEvents = integer(value.objective.minCausalEvents, "request.objective.minCausalEvents", errors, 1, 10_000_000);
    const minEntitiesCreated = integer(value.objective.minEntitiesCreated, "request.objective.minEntitiesCreated", errors, 0, 1_000_000);
    if (typeof value.objective.requireCompleted !== "boolean") errors.push({ path: "request.objective.requireCompleted", message: "must be a boolean" });
    let gravity: GravityCondition | undefined;
    if (value.objective.gravity !== undefined) {
      if (!isRecord(value.objective.gravity)) {
        errors.push({ path: "request.objective.gravity", message: "must be an object" });
      } else {
        onlyKeys(value.objective.gravity, ["comparison", "value"], "request.objective.gravity", errors);
        if (value.objective.gravity.comparison !== "lte" && value.objective.gravity.comparison !== "gte") errors.push({ path: "request.objective.gravity.comparison", message: "must be lte or gte" });
        const gravityValue = finiteNumber(value.objective.gravity.value, "request.objective.gravity.value", errors);
        if (gravityValue !== undefined && (value.objective.gravity.comparison === "lte" || value.objective.gravity.comparison === "gte")) gravity = { comparison: value.objective.gravity.comparison, value: gravityValue };
      }
    }
    if (minCausalEvents !== undefined && minEntitiesCreated !== undefined && typeof value.objective.requireCompleted === "boolean") {
      objective = gravity === undefined
        ? { type: "causal-chain", minCausalEvents, minEntitiesCreated, requireCompleted: value.objective.requireCompleted }
        : { type: "causal-chain", minCausalEvents, minEntitiesCreated, gravity, requireCompleted: value.objective.requireCompleted };
    }
  }

  let budget: SearchBudget | undefined;
  if (!isRecord(value.budget)) {
    errors.push({ path: "request.budget", message: "must be an object" });
  } else {
    onlyKeys(value.budget, ["maxCandidates", "maxEvaluations"], "request.budget", errors);
    const maxCandidates = integer(value.budget.maxCandidates, "request.budget.maxCandidates", errors, 1, 1_000_000);
    const maxEvaluations = integer(value.budget.maxEvaluations, "request.budget.maxEvaluations", errors, 1, 1_000_000);
    if (maxCandidates !== undefined && maxEvaluations !== undefined) budget = { maxCandidates, maxEvaluations };
  }

  const simulationProbe = validateSimulationRequest({
    schemaVersion: 1,
    engineVersion: value.engineVersion,
    seed: value.seed,
    initialState: value.initialState,
    rules: [],
    config: value.simulationConfig,
  });
  errors.push(...simulationProbe.errors.map((error) => ({ ...error, path: error.path.replace(/^request\.(rules|config)/, "request.simulationConfig") })));

  if (errors.length > 0 || engineVersion === undefined || seed === undefined || !rulesResult.value || constraints === undefined || objective === undefined || budget === undefined || !simulationProbe.value) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      engineVersion,
      seed,
      initialState: simulationProbe.value.initialState,
      availableRules: rulesResult.value,
      constraints,
      objective,
      budget,
      simulationConfig: simulationProbe.value.config,
    },
    errors: [],
  };
}
