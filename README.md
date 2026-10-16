# Rule Riot backend

Rule Riot is a deterministic, open-source simulation engine that searches
combinations of validated state-transition rules and records the causal events
behind interesting outcomes. This repository contains the backend only; no
frontend is included.

## Architecture

The backend is a small TypeScript/Node.js application with these planned
boundaries:

- `src/domain/` — typed world state, events, rules, canonical serialization,
  and result contracts.
- `src/rules/` — runtime validation of the closed rule vocabulary.
- `src/simulation/` — bounded event scheduling, state transitions, and trace
  construction.
- `src/search/` — candidate generation, objective scoring, and search budgets.
- `src/trace/` — canonical event traces and deterministic replay verification.
- `src/cli.ts` — JSON-oriented command-line boundary for the real engine.
- `test/` — unit and end-to-end tests that exercise the production modules.

Key invariants are deterministic ordering, validated data-only rules (never
`eval` or arbitrary code), explicit event/entity/step budgets, causal parent
references for generated events, and honest termination statuses.

The simulation core is a pure library boundary: it accepts a JSON-compatible
request and returns a structured result. It never evaluates rule-provided
JavaScript. Rule definitions are data with an allowlisted trigger/effect
vocabulary. External inputs are validated at runtime, including unknown-field
rejection, finite-number checks, duplicate rule IDs, and resource limits.

## Simulation semantics implemented so far

The world contains entities with positions, velocity, health, heat, and an
alive flag, plus scalar gravity and ambient heat. Initial entities at the same
position create deterministic collision events. Rules may respond to
`collision`, `damage`, `entity-created`, `heat-changed`,
`gravity-changed`, `entity-destroyed`, or `tick` events with these effects:

- damage an event entity or target;
- create a bounded entity with explicit properties and offsets;
- change entity/world heat;
- change gravity; or
- destroy an entity.

Events are ordered by logical step, event priority, and insertion sequence.
Rules are sorted by locale-independent rule ID before matching. Generated
events inherit the triggering event as their causal parent and carry the rule
that scheduled them. Entity IDs are deterministic (`entity-N`) and never
overwrite an existing entity. `maxSteps`, `maxEvents`, and `maxEntities` are
logical safety budgets; hitting one is reported as `limit-exhausted`, not as a
completed simulation. The request seed is preserved for reproducibility, but
the current vocabulary does not use randomness.

Every successful or limit-terminated run already contains state-before/state-
after snapshots and scheduled-event details in its structured trace. Search,
replay, and the CLI all use the same production engine APIs.

## Surprise Compiler search

`runSearch` exhaustively enumerates each rule combination between
`constraints.minRules` and `constraints.maxRules`, using stable code-point rule
ID ordering. A candidate is evaluated once through `runSimulation`; no search
path has a separate or simulated execution model. The search stops at either
the end of the finite combination space or its `maxCandidates` /
`maxEvaluations` budgets and reports which occurred.

The initial objective is `causal-chain`. Its score is:

```text
longest causal chain × 1,000,000
  + entities created × 1,000
  + 1 when the optional gravity condition is satisfied
```

The candidate qualifies only when the longest chain reaches
`minCausalEvents`, the simulation creates at least `minEntitiesCreated`, the
optional gravity predicate passes, and (when requested) the simulation ends
normally rather than at a safety limit. A chain follows `parentEventId` links
among processed trace entries, so unrelated event volume does not inflate the
objective. Ties are resolved by the canonical rule-ID list. A successful
discovery includes the selected rule IDs, objective measurements, the complete
simulation trace, and the full search request needed to reproduce it.

## Trace and replay verification

Each simulation trace records the engine and trace schema versions, seed, full
validated request, ordered event entries, state snapshots before and after each
event, matched rules, effects, newly scheduled events, terminal reason, and
metrics. `verifyReplay` validates the recorded request, runs it again through
the production engine, and compares canonical final state, termination,
metrics, and every trace entry. It returns an explicit mismatch with the
compared field rather than correcting the record. This is deterministic replay
verification, not cryptographic integrity or tamper-proof storage; a separately
recomputed self-consistent record cannot be distinguished from an authentic one
without an external trust mechanism.

## CLI

The CLI is a thin adapter over the same library functions used by the tests; it
does not contain a second simulation implementation. Commands read one JSON
document from stdin by default or from `--input FILE`, and write structured JSON
to stdout. Diagnostics go to stderr. Exit codes are `0` for a successful
operation, `1` for invalid input/usage, `2` for an honest no-match, limit, or
replay mismatch, and `3` for an unexpected internal error.

```sh
npm run build
node dist/src/cli.js list-rules
node dist/src/cli.js validate --input rules.json
node dist/src/cli.js simulate --input simulation-request.json > simulation-result.json
node dist/src/cli.js search --input search-request.json > discovery.json
node dist/src/cli.js inspect --input discovery.json
node dist/src/cli.js verify --input discovery.json
```

`validate` accepts either a raw rule array or `{ "rules": [...] }`.
`simulate` accepts a `SimulationRequest`, `search` accepts a `SearchRequest`,
and `verify` accepts a `SimulationTrace` or a found search result. There is no
HTTP API in this backend: adding a server would not provide value for the
current reproducible CLI workflow and would add lifecycle state that the
product does not yet require.

## Development commands

Use Node.js `22.12.0` (the version is pinned in `.nvmrc`). Install the locked
dependencies with:

```sh
npm ci
```

The checks are:

```sh
npm test       # build, then run all compiled Node tests
npm run build
npm run typecheck
npm run lint   # strict TypeScript validation until a separate linter is needed
```

At this phase the repository has no CLI or HTTP API yet. The discovery and
replay operations are available as library APIs and will be exposed by the CLI
only when that real boundary is implemented.
