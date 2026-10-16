import assert from "node:assert/strict";
import test from "node:test";
import { ENGINE_VERSION, runSearch, type RuleDefinition, type SearchRequest } from "../src/index.js";

const rules: RuleDefinition[] = [
  {
    id: "collision-damage",
    name: "Collision damages target",
    trigger: { eventType: "collision" },
    effects: [{ type: "damage", target: "target", amount: 5 }],
  },
  {
    id: "damage-spawns",
    name: "Damage creates a fragment",
    trigger: { eventType: "damage", conditions: { minAmount: 5 } },
    effects: [{ type: "create-entity", kind: "fragment", health: 20, heat: 0, xOffset: 0, yOffset: 0, vx: 0, vy: 0 }],
  },
  {
    id: "heat-reverses-gravity",
    name: "Heat reverses gravity",
    trigger: { eventType: "heat-changed", conditions: { minAmount: 5 } },
    effects: [{ type: "change-gravity", amount: -3 }],
  },
  {
    id: "spawn-heats",
    name: "A new fragment releases heat",
    trigger: { eventType: "entity-created" },
    effects: [{ type: "change-heat", target: "entity", amount: 5 }],
  },
];

function searchRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    seed: "search-fixture",
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
    availableRules: rules,
    constraints: { minRules: 1, maxRules: 4 },
    objective: { type: "causal-chain", minCausalEvents: 5, minEntitiesCreated: 1, gravity: { comparison: "lte", value: -1 }, requireCompleted: true },
    budget: { maxCandidates: 20, maxEvaluations: 20 },
    simulationConfig: { maxSteps: 10, maxEvents: 100, maxEntities: 10 },
    ...overrides,
  };
}

test("discovers a qualifying combination through bounded candidate search", () => {
  const result = runSearch(searchRequest());
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.deepEqual(result.discovery?.ruleIds, ["collision-damage", "damage-spawns", "heat-reverses-gravity", "spawn-heats"]);
  assert.equal(result.discovery?.score.qualifies, true);
  assert.equal(result.discovery?.score.longestCausalChain, 5);
  assert.equal(result.discovery?.score.entitiesCreated, 1);
  assert.equal(result.discovery?.simulation.finalState.gravity, -2);
  assert.equal(result.stats.candidatesGenerated, 15);
  assert.equal(result.stats.candidatesEvaluated, 15);
  assert.equal(result.stats.searchTermination, "completed");
  assert.ok(result.discovery?.simulation.entries.every((entry) => entry.event.parentEventId === undefined || result.discovery?.simulation.entries.some((parent) => parent.event.id === entry.event.parentEventId)));
});

test("reports no-match honestly when the complete bounded space has no qualifying result", () => {
  const result = runSearch(searchRequest({ objective: { type: "causal-chain", minCausalEvents: 50, minEntitiesCreated: 1, requireCompleted: true } }));
  assert.equal(result.status, "no-match");
  if (result.status === "no-match") {
    assert.equal(result.discovery, undefined);
    assert.equal(result.stats.searchTermination, "completed");
    assert.match(result.message, /No candidate/);
  }
});

test("stops honestly at a search budget without fabricating a discovery", () => {
  const result = runSearch(searchRequest({ budget: { maxCandidates: 3, maxEvaluations: 3 } }));
  assert.equal(result.status, "no-match");
  if (result.status === "no-match") {
    assert.equal(result.discovery, undefined);
    assert.equal(result.stats.candidatesGenerated, 3);
    assert.equal(result.stats.candidatesEvaluated, 3);
    assert.equal(result.stats.searchTermination, "budget-exhausted");
  }
});

test("rejects invalid search constraints before evaluating candidates", () => {
  const result = runSearch(searchRequest({ constraints: { minRules: 5, maxRules: 4 } }));
  assert.equal(result.status, "invalid-input");
  if (result.status === "invalid-input") assert.ok(result.errors.some((error) => error.path === "request.constraints"));
});
