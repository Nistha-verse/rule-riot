import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ENGINE_VERSION } from "../src/index.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(args: string[], input?: unknown): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function simulationInput() {
  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    seed: "cli-fixture",
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

test("lists the real supported rule vocabulary", () => {
  const result = runCli(["list-rules"]);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout) as { events: string[]; effects: string[] };
  assert.ok(output.events.includes("collision"));
  assert.ok(output.effects.includes("create-entity"));
});

test("validates, simulates, inspects, and replays through the production CLI", () => {
  const input = simulationInput();
  const valid = runCli(["validate"], { rules: input.rules });
  assert.equal(valid.status, 0);
  assert.equal(JSON.parse(valid.stdout).valid, true);

  const simulation = runCli(["simulate"], input);
  assert.equal(simulation.status, 0);
  const trace = JSON.parse(simulation.stdout) as { trace: unknown; status: string };
  assert.equal(trace.status, "completed");

  const inspected = runCli(["inspect"], trace.trace);
  assert.equal(inspected.status, 0);
  assert.ok(JSON.parse(inspected.stdout).entries.length >= 1);

  const verified = runCli(["verify"], trace.trace);
  assert.equal(verified.status, 0);
  assert.equal(JSON.parse(verified.stdout).status, "verified");
});

test("runs a real search and returns nonzero for invalid input", () => {
  const input = simulationInput();
  const search = runCli(["search"], {
    schemaVersion: 1,
    engineVersion: input.engineVersion,
    seed: input.seed,
    initialState: input.initialState,
    availableRules: input.rules,
    constraints: { minRules: 1, maxRules: 1 },
    objective: { type: "causal-chain", minCausalEvents: 2, minEntitiesCreated: 0, requireCompleted: true },
    budget: { maxCandidates: 2, maxEvaluations: 2 },
    simulationConfig: input.config,
  });
  assert.equal(search.status, 0);
  assert.equal(JSON.parse(search.stdout).status, "found");

  const invalid = runCli(["simulate"], { nope: true });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).status, "invalid-input");
});
