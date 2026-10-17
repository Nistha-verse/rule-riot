import type { RuleDefinition, SimulationRequest, WorldState } from "../domain/types.js";
import type { SearchRequest } from "../search/types.js";
import { ENGINE_VERSION } from "../version.js";

export const defaultRules: RuleDefinition[] = [
  {
    id: "collision-damage",
    name: "Impact leaves a mark",
    trigger: { eventType: "collision" },
    effects: [{ type: "damage", target: "target", amount: 5 }],
  },
  {
    id: "damage-spawns",
    name: "Damage sheds a fragment",
    trigger: { eventType: "damage", conditions: { entityKind: "core", minAmount: 5 } },
    effects: [{ type: "create-entity", kind: "fragment", health: 20, heat: 0, xOffset: 0, yOffset: 0, vx: 0.2, vy: -0.2 }],
  },
  {
    id: "spawn-heats",
    name: "New matter carries heat",
    trigger: { eventType: "entity-created" },
    effects: [{ type: "change-heat", target: "entity", amount: 5 }],
  },
  {
    id: "heat-reverses-gravity",
    name: "Heat turns the world",
    trigger: { eventType: "heat-changed", conditions: { minAmount: 5 } },
    effects: [{ type: "change-gravity", amount: -3 }],
  },
  {
    id: "collision-kick",
    name: "Impacts kick the pair",
    trigger: { eventType: "collision" },
    effects: [{ type: "change-heat", target: "world", amount: 1 }],
  },
];

export function createInitialWorld(): WorldState {
  return {
    tick: 0,
    gravity: 1,
    ambientHeat: 0,
    nextEntityNumber: 3,
    entities: {
      alpha: { id: "alpha", kind: "core", x: -1.5, y: -1.2, vx: 1.2, vy: 0, health: 100, heat: 0, alive: true },
      beta: { id: "beta", kind: "core", x: 1.5, y: -1.2, vx: -1.2, vy: 0, health: 100, heat: 0, alive: true },
      anchor: { id: "anchor", kind: "thermal", x: 0, y: 1.4, vx: 0, vy: 0, health: 80, heat: 12, alive: true },
    },
  };
}

export function createSimulationRequest(rules: RuleDefinition[] = defaultRules.slice(0, 1)): SimulationRequest {
  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    seed: "rule-riot-browser-v1",
    initialState: createInitialWorld(),
    rules,
    config: { maxSteps: 120, maxEvents: 300, maxEntities: 32 },
  };
}

export function createSearchRequest(rules: RuleDefinition[] = defaultRules): SearchRequest {
  const simulation = createSimulationRequest(rules);
  return {
    schemaVersion: 1,
    engineVersion: simulation.engineVersion,
    seed: simulation.seed,
    initialState: simulation.initialState,
    availableRules: rules,
    constraints: { minRules: 1, maxRules: Math.min(4, rules.length) },
    objective: {
      type: "causal-chain",
      minCausalEvents: 5,
      minEntitiesCreated: 1,
      gravity: { comparison: "lte", value: -1 },
      requireCompleted: true,
    },
    budget: { maxCandidates: 50, maxEvaluations: 50 },
    simulationConfig: { maxSteps: 120, maxEvents: 300, maxEntities: 32 },
  };
}

export const campaignChallenges = [
  {
    id: "first-impact",
    title: "First impact",
    eyebrow: "Lesson 01",
    description: "Make two cores meet and leave a visible mark. Start small, then add one law at a time.",
    objective: "Complete a simulation with a collision event.",
    rules: [defaultRules[0]!],
  },
  {
    id: "chain-reaction",
    title: "A little more heat",
    eyebrow: "Lesson 02",
    description: "Find the four-card chain that turns an impact into new matter, heat, and a gravity flip.",
    objective: "Discover a five-event causal chain.",
    rules: defaultRules.slice(0, 4),
  },
];

export const howToPlay = [
  ["1 / Choose a law", "Rule cards are small, explicit pieces of world logic. Turn them on before you run an experiment."],
  ["2 / Make an impact", "Use Bump Cores, Step, or let the fixed-step arena play. Bodies, boundaries, and collision events are real Rapier physics."],
  ["3 / Read the evidence", "The Sandbox sends the same selected rules to the deterministic backend. Its trace explains what happened."],
  ["4 / Find the surprise", "The Compiler evaluates bounded combinations through the production engine. No-match is an honest result."],
];

export function isCampaignLevelUnlocked(index: number, completedIds: readonly string[]): boolean {
  return index === 0 || completedIds.includes(campaignChallenges[index - 1]?.id ?? "");
}
