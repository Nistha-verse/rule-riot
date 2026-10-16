import assert from "node:assert/strict";
import test from "node:test";
import { ENGINE_VERSION, runSimulation, type RuleDefinition, type SimulationRequest, type WorldState } from "../src/index.js";

function initialState(): WorldState {
  return {
    tick: 0,
    gravity: 1,
    ambientHeat: 0,
    nextEntityNumber: 3,
    entities: {
      alpha: { id: "alpha", kind: "core", x: 0, y: 0, vx: 0, vy: 0, health: 100, heat: 0, alive: true },
      beta: { id: "beta", kind: "core", x: 0, y: 0, vx: 0, vy: 0, health: 100, heat: 0, alive: true },
    },
  };
}

function request(rules: RuleDefinition[], overrides: Partial<SimulationRequest["config"]> = {}): SimulationRequest {
  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    seed: "phase-2-fixture",
    initialState: initialState(),
    rules,
    config: { maxSteps: 10, maxEvents: 100, maxEntities: 10, ...overrides },
  };
}

const chainRules: RuleDefinition[] = [
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
    id: "spawn-heats",
    name: "A new fragment releases heat",
    trigger: { eventType: "entity-created" },
    effects: [{ type: "change-heat", target: "entity", amount: 5 }],
  },
  {
    id: "heat-reverses-gravity",
    name: "Heat reverses gravity",
    trigger: { eventType: "heat-changed", conditions: { minAmount: 5 } },
    effects: [{ type: "change-gravity", amount: -3 }],
  },
];

test("rejects malformed and executable-looking rules at the runtime boundary", () => {
  const result = runSimulation(request([{
    id: "unsafe-rule",
    name: "Unsafe",
    trigger: { eventType: "collision" },
    effects: [{ type: "eval", code: "process.exit(1)" } as never],
  }]));
  assert.equal(result.status, "invalid-input");
  if (result.status === "invalid-input") assert.ok(result.errors.some((error) => error.path.includes("effects[0].type")));
});

test("executes multiple rules through a real causal chain", () => {
  const result = runSimulation(request(chainRules));
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.finalState.gravity, -2);
  assert.equal(Object.keys(result.finalState.entities).length, 3);
  assert.equal(result.metrics.eventsProcessed, 5);
  assert.deepEqual(result.trace.entries.map((entry) => entry.event.type), ["collision", "damage", "entity-created", "heat-changed", "gravity-changed"]);
  assert.deepEqual(result.trace.entries.map((entry) => entry.matchedRuleIds), [["collision-damage"], ["damage-spawns"], ["spawn-heats"], ["heat-reverses-gravity"], []]);
  const entries = result.trace.entries;
  assert.equal(entries[1]!.event.parentEventId, entries[0]!.event.id);
  assert.equal(entries[2]!.event.parentEventId, entries[1]!.event.id);
  assert.equal(entries[3]!.event.parentEventId, entries[2]!.event.id);
  assert.equal(entries[4]!.event.parentEventId, entries[3]!.event.id);
});

test("is byte-stable for identical inputs and seed", () => {
  const first = runSimulation(request(chainRules));
  const second = runSimulation(request(chainRules));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("uses deterministic rule ordering for simultaneous effects", () => {
  const result = runSimulation(request([
    ...chainRules,
    {
      id: "collision-extra-damage",
      name: "Second collision damage",
      trigger: { eventType: "collision" },
      effects: [{ type: "damage", target: "entity", amount: 1 }],
    },
  ]));
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.deepEqual(result.trace.entries[0]!.matchedRuleIds, ["collision-damage", "collision-extra-damage"]);
  assert.equal(result.trace.entries[1]!.event.sourceRuleId, "collision-damage");
  assert.equal(result.trace.entries[2]!.event.sourceRuleId, "collision-extra-damage");
});

test("reports event, entity, and step safety limits instead of claiming completion", () => {
  const eventLimited = runSimulation(request(chainRules, { maxEvents: 1 }));
  assert.equal(eventLimited.status, "limit-exhausted");
  if (eventLimited.status === "limit-exhausted") assert.equal(eventLimited.termination.reason, "max-events");

  const entityLimited = runSimulation(request(chainRules, { maxEntities: 2 }));
  assert.equal(entityLimited.status, "limit-exhausted");
  if (entityLimited.status === "limit-exhausted") assert.equal(entityLimited.termination.reason, "max-entities");

  const stepLimited = runSimulation(request([{
    id: "tick-loop",
    name: "Continue ticking",
    trigger: { eventType: "tick" },
    effects: [{ type: "change-gravity", amount: 1 }],
  }], { maxSteps: 2 }));
  assert.equal(stepLimited.status, "limit-exhausted");
  if (stepLimited.status === "limit-exhausted") assert.equal(stepLimited.termination.reason, "max-steps");
});

test("never overwrites an existing generated-style entity id", () => {
  const state = initialState();
  state.entities["entity-3"] = { id: "entity-3", kind: "thermal", x: 10, y: 10, vx: 0, vy: 0, health: 2, heat: 2, alive: true };
  const result = runSimulation({
    ...request([{
      id: "collision-spawns",
      name: "Collision creates a fragment",
      trigger: { eventType: "collision" },
      effects: [{ type: "create-entity", kind: "fragment", health: 10, heat: 0, xOffset: 0, yOffset: 0, vx: 0, vy: 0 }],
    }]),
    initialState: state,
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.finalState.entities["entity-3"]?.health, 2);
  assert.ok(result.finalState.entities["entity-4"]);
});
