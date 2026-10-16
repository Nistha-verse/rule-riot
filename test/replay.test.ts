import assert from "node:assert/strict";
import test from "node:test";
import { ENGINE_VERSION, runSimulation, verifyReplay, type RuleDefinition, type SimulationTrace } from "../src/index.js";

const rules: RuleDefinition[] = [
  { id: "collision-damage", name: "Damage", trigger: { eventType: "collision" }, effects: [{ type: "damage", target: "target", amount: 5 }] },
  { id: "damage-spawns", name: "Spawn", trigger: { eventType: "damage" }, effects: [{ type: "create-entity", kind: "fragment", health: 10, heat: 0, xOffset: 0, yOffset: 0, vx: 0, vy: 0 }] },
  { id: "spawn-heats", name: "Heat", trigger: { eventType: "entity-created" }, effects: [{ type: "change-heat", target: "entity", amount: 5 }] },
];

function trace(): SimulationTrace {
  const result = runSimulation({
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    seed: "replay-fixture",
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
    rules,
    config: { maxSteps: 10, maxEvents: 100, maxEntities: 10 },
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("fixture did not complete");
  return result.trace;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("verifies an unchanged deterministic trace", () => {
  assert.deepEqual(verifyReplay(trace()), { status: "verified", message: "Deterministic replay matched the recorded trace and final state" });
});

test("reports final-state, event, initial-state, rule, and seed mismatches", () => {
  const alteredState = copy(trace());
  alteredState.finalState.gravity += 1;
  assert.equal(verifyReplay(alteredState).status, "mismatch");

  const alteredEvents = copy(trace());
  alteredEvents.entries[0]!.event.type = "tick";
  assert.equal(verifyReplay(alteredEvents).status, "mismatch");

  const alteredInitial = copy(trace());
  alteredInitial.request.initialState.gravity += 1;
  assert.equal(verifyReplay(alteredInitial).status, "mismatch");

  const alteredRules = copy(trace());
  alteredRules.request.rules[0]!.effects[0] = { type: "damage", target: "target", amount: 6 };
  assert.equal(verifyReplay(alteredRules).status, "mismatch");

  const alteredSeed = copy(trace());
  alteredSeed.seed = "different-seed";
  assert.equal(verifyReplay(alteredSeed).status, "mismatch");
});

test("rejects unsupported engine versions and malformed traces", () => {
  const unsupported = copy(trace());
  unsupported.engineVersion = "99.0.0";
  assert.equal(verifyReplay(unsupported).status, "unsupported-version");

  const malformed = copy(trace()) as unknown as Record<string, unknown>;
  malformed.entries = "corrupt";
  assert.equal(verifyReplay(malformed).status, "invalid-trace");
});
