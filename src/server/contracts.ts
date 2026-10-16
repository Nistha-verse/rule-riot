import { TRACE_SCHEMA_VERSION, REQUEST_SCHEMA_VERSION, type SimulationRequest, type ValidationIssue } from "../domain/types.js";
import { validateRuleSet } from "../rules/validate.js";
import type { SearchRequest } from "../search/types.js";

export const API_VERSION = "v1" as const;
export const API_BODY_LIMIT_BYTES = 1_048_576;

/** Operational limits for untrusted HTTP requests. The library limits remain broader for local tooling. */
export const API_LIMITS = {
  maxInitialEntities: 64,
  maxSimulationSteps: 2_000,
  maxSimulationEvents: 1_000,
  maxSimulationEntities: 64,
  maxSearchRules: 12,
  maxSearchCandidates: 100,
  maxSearchEvaluations: 100,
  maxSearchSimulationSteps: 500,
  maxSearchSimulationEvents: 1_000,
  maxSearchSimulationEntities: 32,
  maxTraceEntries: 1_000,
  maxResponseBytes: 8 * 1024 * 1024,
  searchTimeoutMs: 3_000,
} as const;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    issues?: ValidationIssue[];
    requestId?: string;
  };
}

export interface ApiValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(path: string, message: string): ValidationIssue {
  return { path, message };
}

export function ruleInputFromApi(value: unknown): { rules?: unknown; issues: ValidationIssue[] } {
  if (Array.isArray(value)) return { rules: value, issues: [] };
  if (!isRecord(value)) return { issues: [issue("body", "must be a rule array or an object containing only rules")] };
  const issues = Object.keys(value)
    .filter((key) => key !== "rules")
    .map((key) => issue(`body.${key}`, "unknown field"));
  return { rules: value.rules, issues };
}

export function validateApiRules(value: unknown): ApiValidationResult {
  const input = ruleInputFromApi(value);
  const result = validateRuleSet(input.rules);
  const errors = [...input.issues, ...result.errors];
  return { valid: errors.length === 0, errors };
}

export function apiLimitsForSimulation(request: SimulationRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const initialEntityCount = Object.keys(request.initialState.entities).length;
  if (initialEntityCount > API_LIMITS.maxInitialEntities) issues.push(issue("request.initialState.entities", `must contain at most ${API_LIMITS.maxInitialEntities} entities for HTTP execution`));
  if (request.config.maxSteps > API_LIMITS.maxSimulationSteps) issues.push(issue("request.config.maxSteps", `must be at most ${API_LIMITS.maxSimulationSteps} for HTTP execution`));
  if (request.config.maxEvents > API_LIMITS.maxSimulationEvents) issues.push(issue("request.config.maxEvents", `must be at most ${API_LIMITS.maxSimulationEvents} for HTTP execution`));
  if (request.config.maxEvents > API_LIMITS.maxTraceEntries) issues.push(issue("request.config.maxEvents", `must be at most ${API_LIMITS.maxTraceEntries} so the trace remains bounded`));
  if (request.config.maxEntities > API_LIMITS.maxSimulationEntities) issues.push(issue("request.config.maxEntities", `must be at most ${API_LIMITS.maxSimulationEntities} for HTTP execution`));
  return issues;
}

export function apiLimitsForSearch(request: SearchRequest): ValidationIssue[] {
  const issues = apiLimitsForSimulation({
    schemaVersion: REQUEST_SCHEMA_VERSION,
    engineVersion: request.engineVersion,
    seed: request.seed,
    initialState: request.initialState,
    rules: request.availableRules,
    config: request.simulationConfig,
  });
  if (request.availableRules.length > API_LIMITS.maxSearchRules) issues.push(issue("request.availableRules", `must contain at most ${API_LIMITS.maxSearchRules} rules for HTTP execution`));
  if (request.constraints.maxRules > API_LIMITS.maxSearchRules) issues.push(issue("request.constraints.maxRules", `must be at most ${API_LIMITS.maxSearchRules} for HTTP execution`));
  if (request.budget.maxCandidates > API_LIMITS.maxSearchCandidates) issues.push(issue("request.budget.maxCandidates", `must be at most ${API_LIMITS.maxSearchCandidates} for HTTP execution`));
  if (request.budget.maxEvaluations > API_LIMITS.maxSearchEvaluations) issues.push(issue("request.budget.maxEvaluations", `must be at most ${API_LIMITS.maxSearchEvaluations} for HTTP execution`));
  if (request.simulationConfig.maxSteps > API_LIMITS.maxSearchSimulationSteps) issues.push(issue("request.simulationConfig.maxSteps", `must be at most ${API_LIMITS.maxSearchSimulationSteps} for HTTP execution`));
  if (request.simulationConfig.maxEvents > API_LIMITS.maxSearchSimulationEvents) issues.push(issue("request.simulationConfig.maxEvents", `must be at most ${API_LIMITS.maxSearchSimulationEvents} for HTTP execution`));
  if (request.simulationConfig.maxEvents > API_LIMITS.maxTraceEntries) issues.push(issue("request.simulationConfig.maxEvents", `must be at most ${API_LIMITS.maxTraceEntries} so the trace remains bounded`));
  if (request.simulationConfig.maxEntities > API_LIMITS.maxSearchSimulationEntities) issues.push(issue("request.simulationConfig.maxEntities", `must be at most ${API_LIMITS.maxSearchSimulationEntities} for HTTP execution`));
  if (request.objective.gravity !== undefined && Math.abs(request.objective.gravity.value) > 1_000_000_000) issues.push(issue("request.objective.gravity.value", "must have an absolute value of at most 1000000000 for HTTP execution"));
  return issues;
}

export function traceFromApi(value: unknown): unknown {
  if (isRecord(value) && isRecord(value.discovery) && value.discovery.simulation !== undefined) return value.discovery.simulation;
  return value;
}

export function traceEntryCount(value: unknown): number | undefined {
  const trace = traceFromApi(value);
  return isRecord(trace) && Array.isArray(trace.entries) ? trace.entries.length : undefined;
}

export function apiDocs(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Rule Riot API", version: API_VERSION, description: "Stateless access to deterministic simulation, bounded discovery, and replay verification." },
    servers: [{ url: `/api/${API_VERSION}` }],
    limits: { bodyBytes: API_BODY_LIMIT_BYTES, ...API_LIMITS },
    schemas: {
      ValidationIssue: { type: "object", required: ["path", "message"], properties: { path: { type: "string" }, message: { type: "string" } } },
      Error: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, issues: { type: "array", items: { $ref: "#/schemas/ValidationIssue" } }, requestId: { type: "string" } } } } },
    },
    paths: {
      "/health": { get: { responses: { "200": { description: "Process is ready" } } } },
      "/rules": { get: { responses: { "200": { description: "Supported rule vocabulary and limits" } } } },
      "/validate": { post: { requestBody: { required: true }, responses: { "200": { description: "Rules are valid" }, "400": { description: "Malformed JSON" }, "422": { description: "Invalid rules" } } } },
      "/simulate": { post: { requestBody: { required: true }, responses: { "200": { description: "Simulation completed or hit a declared limit" }, "400": { description: "Malformed JSON" }, "422": { description: "Invalid request or API budget" } } } },
      "/search": { post: { requestBody: { required: true }, responses: { "200": { description: "Found, no-match, or budget-exhausted result" }, "400": { description: "Malformed JSON" }, "422": { description: "Invalid request or API budget" } } } },
      "/verify": { post: { requestBody: { required: true }, responses: { "200": { description: "Verified" }, "400": { description: "Malformed JSON" }, "409": { description: "Replay mismatch" }, "422": { description: "Invalid trace or unsupported version" } } } },
      "/docs": { get: { responses: { "200": { description: "This document" } } } },
    },
    versions: { requestSchemaVersion: REQUEST_SCHEMA_VERSION, traceSchemaVersion: TRACE_SCHEMA_VERSION },
  };
}
