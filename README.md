# Rule Riot backend

Rule Riot is a deterministic, open-source simulation engine that searches
combinations of validated state-transition rules and records the causal events
behind interesting outcomes. This repository contains the backend only; no
frontend is included.

## Product overview

Rule Riot's backend lets a caller submit a small data-only rule catalogue and
an initial world, then either run that exact rule set or search combinations of
the catalogue. A discovery is valid only when the production simulation
actually reaches the objective; the search does not generate a prewritten
story or event trace.

The repository is backend-only. It intentionally has no frontend, persistent
database, cloud service, blockchain, paid API, or HTTP server.

## Architecture

The backend is a small TypeScript/Node.js application with these boundaries:

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

## Setup and development commands

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

`make test` is the single documented offline test command after dependencies
have been installed. It runs the same `npm test` target. `npm ci` is the only
dependency installation step; `package-lock.json` pins the exact dependency
artifacts.

## Reproducible discovery

The checked-in example is a deliberately small bounded problem, not a claimed
benchmark or universal search result. It has four available rules and searches
all 1-, 2-, 3-, and 4-rule combinations (15 candidates). Run the actual
compiler and save its complete result with:

```sh
npm ci
npm run --silent discovery | tee discovery-result.json
node dist/src/cli.js inspect --input discovery-result.json
node dist/src/cli.js verify --input discovery-result.json
```

The command exits nonzero for invalid input, no-match results, or replay
mismatches. `discovery-result.json` is a local generated artifact and is
ignored by the repository.
For a stable named output under the example directory, use:

```sh
npm run --silent discovery > examples/discovery-result.json
node dist/src/cli.js verify --input examples/discovery-result.json
```

The result contains the full `SearchRequest`, selected rule IDs, objective
score, search statistics, and the exact simulation trace required for replay.

## Rule semantics and request shapes

Rules are JSON objects with a lowercase kebab-case `id`, a display `name`, a
`trigger`, and one to eight `effects`. Trigger event types are `collision`,
`damage`, `entity-created`, `heat-changed`, `gravity-changed`,
`entity-destroyed`, and `tick`. Conditions can constrain entity kinds, amount,
gravity, and heat. Effects are `damage`, `create-entity`, `change-heat`,
`change-gravity`, and `destroy-entity`; every numeric property is finite and
every creation effect carries explicit health, heat, position offsets, and
velocity.

`SimulationRequest` contains `schemaVersion`, `engineVersion`, `seed`,
`initialState`, `rules`, and `config`. `SearchRequest` contains the same world
inputs as well as `availableRules`, rule-count constraints, the causal-chain
objective, candidate/evaluation budgets, and simulation limits. The CLI accepts
these objects as JSON; the TypeScript exports in `src/index.ts` are the library
boundary for embedding the engine.

## Determinism, limits, and statistics

Determinism is defined over the validated JSON request and engine version:
logical ticks replace wall-clock time; entity IDs are sequential; event order
is logical step, event priority, then sequence; and rule/entity ordering uses a
locale-independent code-point comparator. The seed is recorded even though
the current rule vocabulary has no random operation. The engine does not claim
cross-version compatibility: a trace names the exact engine version and replay
rejects unsupported versions.

`maxSteps`, `maxEvents`, and `maxEntities` are logical safety limits. A
simulation reports `completed` only after its event queue is exhausted. A limit
termination is `limit-exhausted` with a `termination.reason` of `max-steps`,
`max-events`, or `max-entities`. Search statistics mean:

- `candidatesGenerated`: unique combinations admitted to the search budget;
- `candidatesEvaluated`: those combinations actually sent to the simulation;
- `invalidCandidates`: candidates rejected by the production simulation input
  boundary (normally zero after catalogue validation);
- `simulationsLimitTerminated`: evaluated simulations that hit a safety limit;
- `duplicateCandidatesSkipped`: combinations skipped because their canonical
  ID list was already seen; and
- `searchTermination`: whether the finite candidate space completed or the
  search budget ended first.

The search is exhaustive only within its explicitly bounded combination space.
It does not claim global optimality beyond that space and does not use a wall
clock timeout as a semantic result.

## Docker

The Dockerfile pins Node.js `22.12.0`, installs from the lockfile, builds the
TypeScript output in a builder stage, and copies only production dependencies
and compiled output into the runtime stage. Build and run it with:

```sh
make docker-build
docker run --rm -i rule-riot:local list-rules
docker run --rm -i -v "$PWD/examples:/examples:ro" rule-riot:local search --input /examples/search-request.json
```

## Known limitations and future work

- The world model is intentionally small: there is no continuous physics,
  spatial index, networking, persistence layer, or frontend.
- The event vocabulary currently has no random effect, so changing `seed` does
  not change outcomes. It is retained as a versioned reproducibility input for
  future seeded operations.
- Search is exhaustive and suitable for small catalogues only. Larger spaces
  need a separately specified deterministic strategy such as beam search or
  branch-and-bound; no such strategy is implied by this implementation.
- Replay verification reruns and compares deterministic data. It is not a
  cryptographic signature, tamper-proof log, or independent implementation of
  the physics.
- The HTTP API and frontend are intentionally unfinished because the current
  CLI and library boundary provide the required demonstrable backend without
  introducing asynchronous lifecycle or deployment state.
