import assert from "node:assert/strict";
import test from "node:test";
import { createSearchRequest, createSimulationRequest, defaultRules } from "../src/client/model.js";
import { causalChainIds, createTraceCursor, currentTraceEntry, moveTraceCursor } from "../src/client/trace.js";
import { PhysicsArena } from "../src/client/physics.js";
import { ApiError, createApiClient } from "../src/client/api.js";
import type { SimulationTrace } from "../src/domain/types.js";

test("builds browser requests from the same supported rule catalogue", () => {
  const simulation = createSimulationRequest(defaultRules.slice(0, 2));
  assert.equal(simulation.engineVersion, "0.1.0");
  assert.equal(simulation.rules.length, 2);
  const search = createSearchRequest(defaultRules);
  assert.equal(search.availableRules.length, defaultRules.length);
  assert.ok(search.constraints.maxRules <= 4);
  assert.equal(search.objective.type, "causal-chain");
});

test("moves a trace cursor and follows causal parents", () => {
  const trace = {
    traceSchemaVersion: 1,
    engineVersion: "0.1.0",
    seed: "test",
    request: {} as SimulationTrace["request"],
    entries: [
      { event: { id: "event-1", sequence: 1, step: 0, type: "collision" }, stateBefore: {} as never, matchedRuleIds: [], appliedEffects: [], scheduledEvents: [], stateAfter: {} as never },
      { event: { id: "event-2", sequence: 2, step: 0, type: "damage", parentEventId: "event-1" }, stateBefore: {} as never, matchedRuleIds: [], appliedEffects: [], scheduledEvents: [], stateAfter: {} as never },
      { event: { id: "event-3", sequence: 3, step: 0, type: "gravity-changed", parentEventId: "event-2" }, stateBefore: {} as never, matchedRuleIds: [], appliedEffects: [], scheduledEvents: [], stateAfter: {} as never },
    ],
    finalState: {} as never,
    termination: { reason: "completed", message: "done" },
    metrics: { eventsProcessed: 3, eventsScheduled: 3, stepsProcessed: 1, entitiesCreated: 0, maxQueueDepth: 1 },
  } satisfies SimulationTrace;
  let cursor = createTraceCursor(trace);
  assert.equal(currentTraceEntry(cursor)?.event.id, "event-1");
  cursor = moveTraceCursor(cursor, 10);
  assert.equal(currentTraceEntry(cursor)?.event.id, "event-3");
  assert.deepEqual(causalChainIds(trace, "event-3"), ["event-1", "event-2", "event-3"]);
  cursor = moveTraceCursor(cursor, -2);
  assert.equal(cursor.index, 0);
});

test("runs a fixed-step Rapier arena and keeps rule-driven creation bounded", async () => {
  const arena = new PhysicsArena();
  await arena.ready;
  arena.setRules(defaultRules.slice(0, 4));
  for (let index = 0; index < 90; index += 1) arena.stepOnce();
  const snapshot = arena.snapshot();
  assert.equal(snapshot.step, 90);
  assert.ok(snapshot.entities.length <= 32);
  assert.ok(snapshot.entities.some((entity) => entity.id === "alpha"));
  assert.ok(snapshot.lastEvent !== null);
  arena.dispose();
});

test("keeps browser API calls typed and maps structured server errors", async () => {
  const client = createApiClient(async (input) => {
    if (String(input).endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: "invalid-input", message: "bad request" } }), { status: 422 });
  });
  assert.deepEqual(await client.health(), { status: "ok" });
  await assert.rejects(() => client.rules(), (error: unknown) => error instanceof ApiError && error.status === 422 && error.message === "bad request");
});
