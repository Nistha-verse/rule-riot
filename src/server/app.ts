import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ENGINE_VERSION } from "../version.js";
import {
  REQUEST_SCHEMA_VERSION,
  TRACE_SCHEMA_VERSION,
  type ValidationIssue,
} from "../domain/types.js";
import { validateRuleSet, validateSimulationRequest } from "../rules/validate.js";
import { SUPPORTED_EFFECT_TARGETS, SUPPORTED_EFFECT_TYPES, SUPPORTED_ENTITY_KINDS, SUPPORTED_EVENT_TYPES } from "../rules/vocabulary.js";
import { runSearch } from "../search/compiler.js";
import { validateSearchRequest } from "../search/validate.js";
import { runSimulation } from "../simulation/engine.js";
import { verifyReplay } from "../trace/replay.js";
import {
  API_BODY_LIMIT_BYTES,
  API_LIMITS,
  API_VERSION,
  apiDocs,
  apiLimitsForSearch,
  apiLimitsForSimulation,
  traceEntryCount,
  traceFromApi,
  validateApiRules,
} from "./contracts.js";

export interface ApiDependencies {
  runSimulation: typeof runSimulation;
  runSearch: typeof runSearch;
  verifyReplay: typeof verifyReplay;
}

const productionDependencies: ApiDependencies = { runSimulation, runSearch, verifyReplay };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string, issues?: ValidationIssue[]): void {
  const error: { code: string; message: string; issues?: ValidationIssue[]; requestId?: string } = { code, message, requestId: reply.request.id };
  if (issues !== undefined && issues.length > 0) error.issues = issues;
  void reply.code(statusCode).send({ error });
}

function sendValidation(reply: FastifyReply, message: string, issues: ValidationIssue[]): void {
  sendError(reply, 422, "invalid-input", message, issues);
}

function body(request: FastifyRequest): unknown {
  return request.body as unknown;
}

function supportedRules() {
  return {
    apiVersion: API_VERSION,
    engineVersion: ENGINE_VERSION,
    requestSchemaVersion: REQUEST_SCHEMA_VERSION,
    traceSchemaVersion: TRACE_SCHEMA_VERSION,
    events: SUPPORTED_EVENT_TYPES,
    effects: SUPPORTED_EFFECT_TYPES,
    entityKinds: SUPPORTED_ENTITY_KINDS,
    effectTargets: SUPPORTED_EFFECT_TARGETS,
    limits: { bodyBytes: API_BODY_LIMIT_BYTES, ...API_LIMITS },
  };
}

function requestId(request: FastifyRequest): string {
  return request.id;
}

export function createApiApp(dependencies: Partial<ApiDependencies> = {}): FastifyInstance {
  const api = { ...productionDependencies, ...dependencies };
  const app = Fastify({
    bodyLimit: API_BODY_LIMIT_BYTES,
    logger: false,
    requestIdHeader: "x-request-id",
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "POST") {
      const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) {
        sendError(reply, 415, "unsupported-media-type", "POST request bodies must use application/json");
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const typedError = error as { statusCode?: number; code?: string };
    const statusCode = typedError.statusCode ?? 500;
    if (typedError.code === "FST_ERR_CTP_INVALID_JSON_BODY" || typedError.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      sendError(reply, 400, "invalid-json", "Request body is not valid JSON", [{ path: "body", message: "must contain one valid JSON value" }]);
      return;
    }
    if (typedError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      sendError(reply, 413, "body-too-large", `Request body exceeds ${API_BODY_LIMIT_BYTES} bytes`);
      return;
    }
    if (typedError.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      sendError(reply, 415, "unsupported-media-type", "POST request bodies must use application/json");
      return;
    }
    if (statusCode >= 400 && statusCode < 500) {
      sendError(reply, statusCode, statusCode === 404 ? "not-found" : "request-error", statusCode === 404 ? "Route not found" : "Request could not be processed");
      return;
    }
    request.log.error({ err: error, requestId: request.id }, "Unhandled API error");
    sendError(reply, 500, "internal", "The server could not complete the request");
  });

  app.setNotFoundHandler((request, reply) => {
    sendError(reply, 404, "not-found", `No route for ${request.method} ${request.url}`);
  });

  app.get("/api/v1/health", async (_request, reply) => {
    return reply.code(200).send({ status: "ok", apiVersion: API_VERSION, engineVersion: ENGINE_VERSION, requestSchemaVersion: REQUEST_SCHEMA_VERSION, traceSchemaVersion: TRACE_SCHEMA_VERSION });
  });

  app.get("/api/v1/rules", async (_request, reply) => reply.code(200).send(supportedRules()));
  app.get("/api/v1/docs", async (_request, reply) => reply.code(200).send(apiDocs()));

  app.post("/api/v1/validate", async (request, reply) => {
    const result = validateApiRules(body(request));
    if (!result.valid) {
      sendValidation(reply, "Rule validation failed", result.errors);
      return;
    }
    return reply.code(200).send(result);
  });

  app.post("/api/v1/simulate", async (request, reply) => {
    const validated = validateSimulationRequest(body(request));
    if (!validated.ok || validated.value === undefined) {
      sendValidation(reply, "Simulation request validation failed", validated.errors);
      return;
    }
    const limitIssues = apiLimitsForSimulation(validated.value);
    if (limitIssues.length > 0) {
      sendValidation(reply, "Simulation request exceeds the HTTP execution limits", limitIssues);
      return;
    }
    const result = api.runSimulation(body(request));
    if (result.status === "invalid-input") {
      sendValidation(reply, "Simulation request validation failed", result.errors);
      return;
    }
    return reply.code(200).send(result);
  });

  app.post("/api/v1/search", async (request, reply) => {
    const validated = validateSearchRequest(body(request));
    if (!validated.ok || validated.value === undefined) {
      sendValidation(reply, "Search request validation failed", validated.errors);
      return;
    }
    const limitIssues = apiLimitsForSearch(validated.value);
    if (limitIssues.length > 0) {
      sendValidation(reply, "Search request exceeds the HTTP execution limits", limitIssues);
      return;
    }
    const result = api.runSearch(body(request));
    if (result.status === "invalid-input") {
      sendValidation(reply, "Search request validation failed", result.errors);
      return;
    }
    return reply.code(200).send(result);
  });

  app.post("/api/v1/verify", async (request, reply) => {
    const trace = traceFromApi(body(request));
    const entries = traceEntryCount(trace);
    if (entries !== undefined && entries > API_LIMITS.maxTraceEntries) {
      sendValidation(reply, "Trace exceeds the HTTP verification limits", [{ path: "trace.entries", message: `must contain at most ${API_LIMITS.maxTraceEntries} entries for HTTP verification` }]);
      return;
    }
    const result = api.verifyReplay(trace);
    if (result.status === "verified") return reply.code(200).send(result);
    if (result.status === "mismatch") return reply.code(409).send(result);
    if (result.status === "unsupported-version") {
      sendError(reply, 422, "unsupported-version", result.message);
      return;
    }
    sendValidation(reply, "Replay trace is invalid", result.errors);
  });

  // Keep an explicit reference to the request id helper so route changes cannot
  // accidentally remove request correlation from the error contract.
  void requestId;
  return app;
}
