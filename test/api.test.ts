import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createApiApp, ENGINE_VERSION, runSearch, runSimulation, type SearchRequest, type SimulationRequest } from "../src/index.js";
import { API_BODY_LIMIT_BYTES, API_LIMITS } from "../src/server/contracts.js";

const app = createApiApp();
after(async () => {
  await app.close();
});

function simulationRequest(): SimulationRequest {
  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    seed: "api-fixture",
    initialState: {
      tick: 0,
      gravity: 1,
      ambientHeat: 0,
      nextEntityNumber: 3,
      entities: {
        alpha: { id: "alpha", kind: "core", x: 0, y: 0, vx: 0, vy: 0, health: 100, heat: 0, alive: true },
        beta: { id: "beta", kind: "core", x: 0, y: 0, vx: 0, vy: 0, health: 100, heat: 0, alive: true },
      },
    },
    rules: [{ id: "collision-damage", name: "Damage", trigger: { eventType: "collision" }, effects: [{ type: "damage", target: "target", amount: 5 }] }],
    config: { maxSteps: 5, maxEvents: 20, maxEntities: 10 },
  };
}

function searchRequest(): SearchRequest {
  const base = simulationRequest();
  const availableRules: SearchRequest["availableRules"] = [
    ...base.rules,
    { id: "damage-spawns", name: "Spawn", trigger: { eventType: "damage", conditions: { minAmount: 5 } }, effects: [{ type: "create-entity", kind: "fragment", health: 20, heat: 0, xOffset: 0, yOffset: 0, vx: 0, vy: 0 }] },
    { id: "heat-reverses-gravity", name: "Reverse gravity", trigger: { eventType: "heat-changed", conditions: { minAmount: 5 } }, effects: [{ type: "change-gravity", amount: -3 }] },
    { id: "spawn-heats", name: "Heat", trigger: { eventType: "entity-created" }, effects: [{ type: "change-heat", target: "entity", amount: 5 }] },
  ];
  return {
    schemaVersion: 1,
    engineVersion: base.engineVersion,
    seed: base.seed,
    initialState: base.initialState,
    availableRules,
    constraints: { minRules: 1, maxRules: 4 },
    objective: { type: "causal-chain", minCausalEvents: 5, minEntitiesCreated: 1, gravity: { comparison: "lte", value: -1 }, requireCompleted: true },
    budget: { maxCandidates: 20, maxEvaluations: 20 },
    simulationConfig: { maxSteps: 10, maxEvents: 100, maxEntities: 10 },
  };
}

function json(response: { body: string }): unknown {
  return JSON.parse(response.body) as unknown;
}

test("serves health, rules, and API documentation", async () => {
  const frontend = await app.inject({ method: "GET", url: "/" });
  assert.equal(frontend.statusCode, 200);
  assert.match(frontend.body, /RULE RIOT|Rule Riot/);

  const health = await app.inject({ method: "GET", url: "/api/v1/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(json(health), { status: "ok", apiVersion: "v1", engineVersion: ENGINE_VERSION, requestSchemaVersion: 1, traceSchemaVersion: 1 });

  const rules = await app.inject({ method: "GET", url: "/api/v1/rules" });
  assert.equal(rules.statusCode, 200);
  assert.ok((json(rules) as { events: string[] }).events.includes("collision"));
  assert.equal((json(rules) as { limits: { bodyBytes: number } }).limits.bodyBytes, API_BODY_LIMIT_BYTES);

  const docs = await app.inject({ method: "GET", url: "/api/v1/docs" });
  assert.equal(docs.statusCode, 200);
  assert.ok((json(docs) as { paths: Record<string, unknown> }).paths["/search"]);
});

test("validates and simulates through the actual production engine", async () => {
  const request = simulationRequest();
  const validation = await app.inject({ method: "POST", url: "/api/v1/validate", headers: { "content-type": "application/json" }, payload: { rules: request.rules } });
  assert.equal(validation.statusCode, 200);
  assert.deepEqual(json(validation), { valid: true, errors: [] });

  const response = await app.inject({ method: "POST", url: "/api/v1/simulate", headers: { "content-type": "application/json" }, payload: request });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(json(response), runSimulation(request));
});

test("runs a real discovery, returns honest no-match/budget outcomes, and verifies its trace", async () => {
  const request = searchRequest();
  const expected = runSearch(request);
  const response = await app.inject({ method: "POST", url: "/api/v1/search", headers: { "content-type": "application/json" }, payload: request });
  assert.equal(response.statusCode, 200);
  const result = json(response) as typeof expected;
  assert.deepEqual(result, expected);
  assert.equal(result.status, "found");
  if (result.status !== "found") return;

  const verify = await app.inject({ method: "POST", url: "/api/v1/verify", headers: { "content-type": "application/json" }, payload: result });
  assert.equal(verify.statusCode, 200);
  assert.equal((json(verify) as { status: string }).status, "verified");

  const noMatch = await app.inject({ method: "POST", url: "/api/v1/search", headers: { "content-type": "application/json" }, payload: { ...request, objective: { ...request.objective, minCausalEvents: 50 } } });
  assert.equal(noMatch.statusCode, 200);
  assert.equal((json(noMatch) as { status: string }).status, "no-match");

  const budget = await app.inject({ method: "POST", url: "/api/v1/search", headers: { "content-type": "application/json" }, payload: { ...request, budget: { maxCandidates: 1, maxEvaluations: 1 } } });
  assert.equal(budget.statusCode, 200);
  const budgetResult = json(budget) as { status: string; stats: { searchTermination: string } };
  assert.equal(budgetResult.status, "no-match");
  assert.equal(budgetResult.stats.searchTermination, "budget-exhausted");
});

test("rejects malformed JSON, content types, unknown fields, versions, and API resource limits", async () => {
  const malformed = await app.inject({ method: "POST", url: "/api/v1/simulate", headers: { "content-type": "application/json" }, payload: "{broken" });
  assert.equal(malformed.statusCode, 400);
  assert.equal((json(malformed) as { error: { code: string } }).error.code, "invalid-json");

  const unsupportedMedia = await app.inject({ method: "POST", url: "/api/v1/simulate", headers: { "content-type": "text/plain" }, payload: "hello" });
  assert.equal(unsupportedMedia.statusCode, 415);
  assert.equal((json(unsupportedMedia) as { error: { code: string } }).error.code, "unsupported-media-type");

  const unknown = await app.inject({ method: "POST", url: "/api/v1/simulate", headers: { "content-type": "application/json" }, payload: { ...simulationRequest(), unexpected: true } });
  assert.equal(unknown.statusCode, 422);
  assert.equal((json(unknown) as { error: { code: string } }).error.code, "invalid-input");

  const unsupportedVersion = await app.inject({ method: "POST", url: "/api/v1/simulate", headers: { "content-type": "application/json" }, payload: { ...simulationRequest(), engineVersion: "99.0.0" } });
  assert.equal(unsupportedVersion.statusCode, 422);

  const overBudget = await app.inject({ method: "POST", url: "/api/v1/search", headers: { "content-type": "application/json" }, payload: { ...searchRequest(), budget: { maxCandidates: API_LIMITS.maxSearchCandidates + 1, maxEvaluations: 1 } } });
  assert.equal(overBudget.statusCode, 422);
  assert.ok((json(overBudget) as { error: { issues: Array<{ path: string }> } }).error.issues.some((issue) => issue.path === "request.budget.maxCandidates"));

  const tooLarge = await app.inject({ method: "POST", url: "/api/v1/simulate", headers: { "content-type": "application/json" }, payload: "{" + "\"padding\":\"" + "x".repeat(API_BODY_LIMIT_BYTES) + "\"}" });
  assert.equal(tooLarge.statusCode, 413);
  assert.equal((json(tooLarge) as { error: { code: string } }).error.code, "body-too-large");
});

test("returns consistent not-found and replay mismatch responses", async () => {
  const missing = await app.inject({ method: "GET", url: "/api/v1/missing" });
  assert.equal(missing.statusCode, 404);
  assert.equal((json(missing) as { error: { code: string } }).error.code, "not-found");

  const simulation = runSimulation(simulationRequest());
  assert.equal(simulation.status, "completed");
  if (simulation.status !== "completed") return;
  const altered = structuredClone(simulation.trace);
  altered.finalState.gravity += 1;
  const mismatch = await app.inject({ method: "POST", url: "/api/v1/verify", headers: { "content-type": "application/json" }, payload: altered });
  assert.equal(mismatch.statusCode, 409);
  const mismatchBody = json(mismatch) as { error: { code: string; issues: Array<{ path: string }> } };
  assert.equal(mismatchBody.error.code, "replay-mismatch");
  assert.equal(mismatchBody.error.issues[0]!.path, "finalState");
});

test("does not leak unexpected handler failures", async () => {
  const failing = createApiApp({ runSimulation: () => { throw new Error("secret local path /private/file"); } });
  const response = await failing.inject({ method: "POST", url: "/api/v1/simulate", headers: { "content-type": "application/json" }, payload: simulationRequest() });
  await failing.close();
  assert.equal(response.statusCode, 500);
  const body = json(response) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "internal");
  assert.equal(body.error.message, "The server could not complete the request");
  assert.doesNotMatch(response.body, /secret local path|private\/file/);
});

test("supports real server startup and graceful shutdown", async () => {
  const server = createApiApp();
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  assert.ok(address && typeof address === "object");
  await server.close();
});

test("supports an explicitly allowed development origin and preflight", async () => {
  const corsApp = createApiApp({}, { allowedOrigin: "http://localhost:5173" });
  const preflight = await corsApp.inject({ method: "OPTIONS", url: "/api/v1/search", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "http://localhost:5173");
  const denied = await corsApp.inject({ method: "OPTIONS", url: "/api/v1/search", headers: { origin: "http://evil.test", "access-control-request-method": "POST" } });
  assert.equal(denied.statusCode, 404);
  await corsApp.close();
});
