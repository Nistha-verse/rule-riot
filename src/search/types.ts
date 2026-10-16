import type {
  RuleDefinition,
  SimulationTrace,
  ValidationIssue,
  WorldState,
} from "../domain/types.js";

export interface RuleCountConstraints {
  minRules: number;
  maxRules: number;
}

export interface SearchBudget {
  maxCandidates: number;
  maxEvaluations: number;
}

export interface GravityCondition {
  comparison: "lte" | "gte";
  value: number;
}

export interface ChainReactionObjective {
  type: "causal-chain";
  minCausalEvents: number;
  minEntitiesCreated: number;
  gravity?: GravityCondition;
  requireCompleted: boolean;
}

export interface SearchRequest {
  schemaVersion: 1;
  engineVersion: string;
  seed: string;
  initialState: WorldState;
  availableRules: RuleDefinition[];
  constraints: RuleCountConstraints;
  objective: ChainReactionObjective;
  budget: SearchBudget;
  simulationConfig: {
    maxSteps: number;
    maxEvents: number;
    maxEntities: number;
  };
}

export interface ObjectiveScore {
  score: number;
  qualifies: boolean;
  longestCausalChain: number;
  entitiesCreated: number;
  gravitySatisfied: boolean;
  completed: boolean;
}

export interface SearchStats {
  candidatesGenerated: number;
  candidatesEvaluated: number;
  invalidCandidates: number;
  simulationsLimitTerminated: number;
  duplicateCandidatesSkipped: number;
  searchTermination: "completed" | "budget-exhausted";
}

export interface Discovery {
  ruleIds: string[];
  score: ObjectiveScore;
  simulation: SimulationTrace;
  searchRequest: SearchRequest;
}

export type InvalidSearchResult = {
  status: "invalid-input";
  errors: ValidationIssue[];
};

export type SearchOutcome = {
  status: "found" | "no-match";
  message: string;
  stats: SearchStats;
  discovery?: Discovery;
  request: SearchRequest;
};

export type SearchResult = InvalidSearchResult | SearchOutcome;
