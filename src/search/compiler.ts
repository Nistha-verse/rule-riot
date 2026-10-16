import { canonicalStringify } from "../domain/canonical.js";
import type { RuleDefinition, SimulationRequest, SimulationTrace, ValidationIssue } from "../domain/types.js";
import { runSimulation } from "../simulation/engine.js";
import { validateSearchRequest } from "./validate.js";
import type {
  ChainReactionObjective,
  Discovery,
  ObjectiveScore,
  SearchRequest,
  SearchResult,
  SearchStats,
} from "./types.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneRequest(request: SearchRequest): SearchRequest {
  return {
    ...request,
    initialState: {
      ...request.initialState,
      entities: Object.fromEntries(Object.entries(request.initialState.entities).sort(([left], [right]) => compareText(left, right)).map(([id, entity]) => [id, { ...entity }])),
    },
    availableRules: request.availableRules.map((rule) => ({ ...rule, trigger: rule.trigger.conditions === undefined ? { eventType: rule.trigger.eventType } : { eventType: rule.trigger.eventType, conditions: { ...rule.trigger.conditions } }, effects: rule.effects.map((effect) => ({ ...effect })) })),
    constraints: { ...request.constraints },
    objective: request.objective.gravity === undefined ? { ...request.objective } : { ...request.objective, gravity: { ...request.objective.gravity } },
    budget: { ...request.budget },
    simulationConfig: { ...request.simulationConfig },
  };
}

function longestCausalChain(trace: SimulationTrace): number {
  const entries = new Map(trace.entries.map((entry) => [entry.event.id, entry]));
  const lengths = new Map<string, number>();
  let longest = 0;
  const lengthFor = (eventId: string, active: Set<string>): number => {
    const known = lengths.get(eventId);
    if (known !== undefined) return known;
    if (active.has(eventId)) return 1;
    active.add(eventId);
    const entry = entries.get(eventId);
    const parent = entry?.event.parentEventId;
    const length = parent !== undefined && entries.has(parent) ? 1 + lengthFor(parent, active) : 1;
    active.delete(eventId);
    lengths.set(eventId, length);
    return length;
  };
  for (const entry of trace.entries) longest = Math.max(longest, lengthFor(entry.event.id, new Set()));
  return longest;
}

export function scoreObjective(trace: SimulationTrace, objective: ChainReactionObjective): ObjectiveScore {
  const longest = longestCausalChain(trace);
  const gravitySatisfied = objective.gravity === undefined
    ? true
    : objective.gravity.comparison === "lte"
      ? trace.finalState.gravity <= objective.gravity.value
      : trace.finalState.gravity >= objective.gravity.value;
  const completed = trace.termination.reason === "completed";
  const qualifies = longest >= objective.minCausalEvents && trace.metrics.entitiesCreated >= objective.minEntitiesCreated && gravitySatisfied && (!objective.requireCompleted || completed);
  const score = longest * 1_000_000 + trace.metrics.entitiesCreated * 1_000 + (gravitySatisfied ? 1 : 0);
  return { score, qualifies, longestCausalChain: longest, entitiesCreated: trace.metrics.entitiesCreated, gravitySatisfied, completed };
}

function combinationCount(ruleCount: number, minRules: number, maxRules: number, cap: number): number {
  let total = 0;
  for (let size = minRules; size <= maxRules; size += 1) {
    let combinations = 1;
    for (let index = 1; index <= size; index += 1) {
      combinations = Math.min(cap + 1, Math.floor((combinations * (ruleCount - size + index)) / index));
    }
    total = Math.min(cap + 1, total + combinations);
  }
  return total;
}

function* combinations<T>(items: T[], minSize: number, maxSize: number): Generator<T[]> {
  function* choose(start: number, size: number, selected: T[]): Generator<T[]> {
    if (selected.length === size) {
      yield [...selected];
      return;
    }
    const remaining = size - selected.length;
    for (let index = start; index <= items.length - remaining; index += 1) {
      selected.push(items[index]!);
      yield* choose(index + 1, size, selected);
      selected.pop();
    }
  }
  for (let size = minSize; size <= maxSize; size += 1) yield* choose(0, size, []);
}

function simulationRequest(request: SearchRequest, rules: RuleDefinition[]): SimulationRequest {
  return {
    schemaVersion: 1,
    engineVersion: request.engineVersion,
    seed: request.seed,
    initialState: request.initialState,
    rules,
    config: request.simulationConfig,
  };
}

function isBetter(candidate: Discovery, best: Discovery | undefined): boolean {
  if (best === undefined) return true;
  return candidate.score.score > best.score.score || (candidate.score.score === best.score.score && canonicalStringify(candidate.ruleIds) < canonicalStringify(best.ruleIds));
}

function invalidResult(errors: ValidationIssue[]): SearchResult {
  return { status: "invalid-input", errors };
}

/** Exhaustively enumerates the bounded rule-combination space in stable order. */
export function runSearch(input: unknown): SearchResult {
  const validation = validateSearchRequest(input);
  if (!validation.ok) return invalidResult(validation.errors);
  const request = validation.value;
  const rules = [...request.availableRules].sort((left, right) => compareText(left.id, right.id));
  const totalCandidates = combinationCount(rules.length, request.constraints.minRules, request.constraints.maxRules, request.budget.maxCandidates);
  const stats: SearchStats = {
    candidatesGenerated: 0,
    candidatesEvaluated: 0,
    invalidCandidates: 0,
    simulationsLimitTerminated: 0,
    duplicateCandidatesSkipped: 0,
    searchTermination: "completed",
  };
  const seen = new Set<string>();
  let best: Discovery | undefined;
  const candidateIterator = combinations(rules, request.constraints.minRules, request.constraints.maxRules);

  for (const candidateRules of candidateIterator) {
    if (stats.candidatesGenerated >= request.budget.maxCandidates || stats.candidatesEvaluated >= request.budget.maxEvaluations) {
      stats.searchTermination = "budget-exhausted";
      break;
    }
    const ruleIds = candidateRules.map((rule) => rule.id);
    const key = ruleIds.join("|");
    if (seen.has(key)) {
      stats.duplicateCandidatesSkipped += 1;
      continue;
    }
    seen.add(key);
    stats.candidatesGenerated += 1;
    const simulation = runSimulation(simulationRequest(request, candidateRules));
    stats.candidatesEvaluated += 1;
    if (simulation.status === "invalid-input") {
      stats.invalidCandidates += 1;
      continue;
    }
    if (simulation.status === "limit-exhausted") stats.simulationsLimitTerminated += 1;
    const score = scoreObjective(simulation.trace, request.objective);
    if (!score.qualifies) continue;
    const discovery: Discovery = { ruleIds, score, simulation: simulation.trace, searchRequest: cloneRequest(request) };
    if (isBetter(discovery, best)) best = discovery;
  }

  if (stats.searchTermination === "completed" && stats.candidatesGenerated < totalCandidates) stats.searchTermination = "budget-exhausted";
  const requestSnapshot = cloneRequest(request);
  if (best !== undefined) {
    return { status: "found", message: stats.searchTermination === "budget-exhausted" ? "A qualifying discovery was found before the search budget ended" : "A qualifying discovery was found after bounded exhaustive search", stats, discovery: best, request: requestSnapshot };
  }
  return {
    status: "no-match",
    message: stats.searchTermination === "budget-exhausted" ? "No qualifying candidate was found within the search budget" : "No candidate in the bounded search space satisfied the objective",
    stats,
    request: requestSnapshot,
  };
}
