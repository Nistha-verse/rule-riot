# Rule Riot

**A deterministic rule-composition engine with a tactile physics playground.**

Rule Riot lets you write small, validated world rules, run them through a
bounded simulation, search combinations for surprising causal chains, and
replay the resulting evidence. It also includes a playable browser experience
powered by real Rapier 2D physics.

> **Live demo:** [rule-riot.vercel.app](https://rule-riot.vercel.app)

## Why Rule Riot?

Most rule systems show you the outcome. Rule Riot shows you **why** it happened.
Rules are data, not executable code. Every generated event records its parent,
the rule that caused it, the state before and after it, and the safety budget
that bounded the run.

The project has two deliberately distinct execution layers:

- **Deterministic engine** — authoritative for API simulations, compiler search,
  CLI output, and replay verification.
- **Rapier arena** — continuous 60 Hz browser physics for tactile interaction,
  collisions, impulses, and campaign play.

The browser arena is not presented as bit-for-bit identical to the backend
trace. That separation keeps both experiences honest and useful.

## Features

- Data-only rules with an allowlisted trigger/effect vocabulary; no `eval`.
- Deterministic event ordering, entity IDs, rule ordering, and canonical JSON.
- Explicit `maxSteps`, `maxEvents`, and `maxEntities` safety budgets.
- Causal event traces with state-before/state-after snapshots.
- Bounded exhaustive search over rule combinations.
- Replay verification that reports the exact mismatch instead of repairing it.
- JSON CLI for validation, simulation, search, inspection, and verification.
- Versioned Fastify HTTP API with request IDs and structured errors.
- Browser Campaign, Play, Sandbox, Compiler, and Replay views.
- Local-only campaign progress; no accounts, database, or client secrets.
- Reproducible Node.js, npm lockfile, Docker, and Vercel workflows.

## Quick start

### Requirements

- Node.js **22.12.0** (pinned in [`.nvmrc`](.nvmrc)).
- npm. The repository includes `package-lock.json`; use `npm ci`.

Install dependencies:

```sh
npm ci
```

Run the complete offline test command:

```sh
make test
```

The test command builds the TypeScript and Vite output first, then runs the
compiled Node test suite against the production modules.

### Start the browser app

For the same-origin production-style app:

```sh
npm run api
```

Open <http://localhost:3000/>.

For fast frontend iteration, use two terminals:

```sh
# terminal 1
npm run api

# terminal 2
npm run dev
```

Open <http://localhost:5173/>. Vite proxies `/api` to the local Fastify
server.

### First experiment

1. Open **Play** and use **Bump cores**, **Step**, **Pause**, and **Reset**.
2. Visit **Sandbox** to select data rules and run the deterministic backend.
3. Use **Compiler** to search bounded rule combinations for a causal chain.
4. Open **Replay** to verify a trace and step through its causal events.

## Architecture

The repository is organized around a small, pure engine boundary:

```text
src/
├── domain/       Typed world, rules, events, traces, and contracts
├── rules/        Runtime validation and vocabulary allowlists
├── simulation/   Bounded deterministic event engine
├── search/       Candidate generation, scoring, and search budgets
├── trace/        Canonical replay verification
├── server/       Fastify API, static host, and search worker
├── client/       Browser shell, Rapier arena, and UI tools
└── cli.ts        JSON-oriented command-line adapter

api/              Vercel HTTP function entry points
examples/         Reproducible request fixtures
test/             Production-module unit and API tests
index.html        Browser entry point
Dockerfile        Reproducible build and runtime image
Makefile          Short development commands
```

The simulation core accepts a JSON-compatible `SimulationRequest` and returns
a structured result. It does not evaluate JavaScript supplied by a rule. The
runtime boundary rejects unknown fields, non-finite numbers, duplicate rule
IDs, unsupported vocabulary, and requests beyond configured limits.

## Rules and simulation

The current world contains entities with:

- position and velocity;
- health and heat;
- an `alive` flag;
- scalar gravity and ambient heat.

Supported trigger event types are:

```text
collision · damage · entity-created · heat-changed
gravity-changed · entity-destroyed · tick
```

Supported effects are:

```text
damage · create-entity · change-heat · change-gravity · destroy-entity
```

A rule has a lowercase kebab-case ID, display name, trigger, optional
conditions, and one to eight effects. Creation effects carry explicit entity
properties and offsets, so generated state remains bounded and reproducible.

Events are ordered by logical step, event priority, and insertion sequence.
Rules are sorted by locale-independent rule ID before matching. Generated events
inherit the triggering event as `parentEventId` and record the scheduling rule
as `sourceRuleId`. Hitting a logical limit produces `limit-exhausted`, never a
false `completed` result.

The request seed is retained in every trace for reproducibility. The current
vocabulary does not use randomness, so changing the seed alone does not change
the result.

## Browser experience

The browser UI is a compact vertical slice built with native TypeScript and
CSS. It includes:

- **Campaign** — two locally tracked challenges that unlock from real physics
  outcomes.
- **Play** — a live Rapier arena with fixed-step controls and collision events.
- **Sandbox** — configure active rule cards and compare live physics with the
  backend trace.
- **Compiler** — run the bounded search objective through the production engine.
- **Replay** — verify a trace and inspect event parents, effects, and snapshots.

The live arena uses `@dimforge/rapier2d-compat` 0.21.0 with dynamic rigid
bodies, ball colliders, restitution, friction, collision events, impulses,
fixed boundaries, a local event queue, and a bounded entity cap. Campaign
progress is optional versioned `localStorage`; it is not server persistence.

Automated checks exercise the request builders, trace cursor, real Rapier WASM
stepping, campaign objective boundaries, static serving, API handlers, and
backend engine. There is no browser automation dependency in the repository.
For a manual smoke check, click through Play, Sandbox, Compiler, and Replay.

## Command-line interface

Build the project before invoking the compiled CLI:

```sh
npm run build
```

Commands read one JSON document from stdin by default or from `--input FILE`.
Structured results go to stdout; diagnostics go to stderr.

```sh
node dist/src/cli.js list-rules
node dist/src/cli.js validate --input rules.json
node dist/src/cli.js simulate --input simulation-request.json > simulation-result.json
node dist/src/cli.js search --input search-request.json > discovery.json
node dist/src/cli.js inspect --input discovery.json
node dist/src/cli.js verify --input discovery.json
```

Exit codes:

| Code | Meaning |
| ---: | --- |
| `0` | Successful operation |
| `1` | Invalid input or CLI usage |
| `2` | Honest no-match, limit termination, or replay mismatch |
| `3` | Unexpected internal error |

`validate` accepts a raw rule array or `{ "rules": [...] }`. `simulate` accepts
a `SimulationRequest`; `search` accepts a `SearchRequest`; and `verify` accepts
a `SimulationTrace` or a found search result.

## Surprise Compiler

`runSearch` exhaustively enumerates rule combinations between
`constraints.minRules` and `constraints.maxRules`, using stable code-point rule
ID ordering. Each candidate is evaluated once through the same production
`runSimulation` function used by direct requests.

The initial objective is `causal-chain`:

```text
longest causal chain × 1,000,000
  + entities created × 1,000
  + 1 when the optional gravity predicate passes
```

A candidate qualifies only when it reaches the requested causal-chain length,
creates enough entities, satisfies the optional gravity predicate, and—when
requested—terminates normally rather than at a safety limit. Search statistics
report candidates generated/evaluated, invalid candidates, limit-terminated
simulations, duplicate combinations, and the search termination reason.

Run the checked-in bounded example:

```sh
npm run --silent discovery > discovery-result.json
node dist/src/cli.js inspect --input discovery-result.json
node dist/src/cli.js verify --input discovery-result.json
```

`discovery-result.json` is ignored by git. The command may return an honest
no-match or budget result; that is a valid computation result, not a fabricated
discovery.

## HTTP API

Start the API with:

```sh
npm run api
# or: HOST=127.0.0.1 PORT=3000 npm run api
```

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Process and engine readiness |
| `GET` | `/api/v1/rules` | Vocabulary and HTTP limits |
| `GET` | `/api/v1/docs` | Machine-readable API contract |
| `POST` | `/api/v1/validate` | Validate rules |
| `POST` | `/api/v1/simulate` | Run the deterministic engine |
| `POST` | `/api/v1/search` | Run bounded rule search |
| `POST` | `/api/v1/verify` | Verify a trace or found result |

POST requests require `Content-Type: application/json`. Honest computation
results such as `limit-exhausted`, `no-match`, and `budget-exhausted` return
HTTP 200. Invalid requests return 422; malformed JSON 400; unsupported media
types 415; oversized bodies 413; replay mismatches 409; and unexpected errors
500.

Example requests:

```sh
curl http://localhost:3000/api/v1/health
curl http://localhost:3000/api/v1/rules
curl -X POST http://localhost:3000/api/v1/search \
  -H 'content-type: application/json' \
  --data-binary @examples/search-request.json
```

Run the API integration tests against the real in-process Fastify handlers:

```sh
npm run api:test
```

The API uses conservative synchronous limits: a 1 MiB request body, bounded
entities/events/steps, capped responses, and a worker execution limit for
search. Exact values are returned by `/api/v1/rules` and `/api/v1/docs`.

## Replay verification

Every valid simulation trace contains:

- engine and trace schema versions;
- the seed and complete validated request;
- ordered events and scheduled-event details;
- state snapshots before and after each event;
- matched rules and applied effects;
- termination reason and metrics.

`verifyReplay` validates the recorded request, runs it again through the
production engine, and compares the canonical final state, termination,
metrics, and every trace entry. It reports the compared path when a mismatch
is found. This is deterministic replay verification, not a cryptographic
signature or tamper-proof log.

## Development

The repository's standard checks are:

```sh
npm test             # build plus all compiled Node tests
npm run build        # TypeScript and Vite production build
npm run typecheck    # TypeScript without emitting files
npm run lint         # strict TypeScript validation
npm run api:test     # production API handler tests
```

Equivalent Make targets are available:

```sh
make test
make build
make typecheck
make api-test
```

`npm ci` is the only dependency installation step. Dependencies are pinned by
`package-lock.json`; build output is generated under `dist/` and ignored by
git. No environment variables are required. Copy [`.env.example`](.env.example)
only if you want a placeholder environment file for local tooling.

## Docker

The multi-stage Dockerfile pins Node.js 22.12.0, installs from the lockfile,
builds the application, and copies only production dependencies and compiled
output into the runtime image.

```sh
make docker-build
docker run --rm -i -p 3000:3000 rule-riot:local
curl http://localhost:3000/api/v1/health
```

To invoke the CLI inside the image:

```sh
docker run --rm -i --entrypoint node rule-riot:local \
  dist/src/cli.js list-rules
```

## Vercel deployment

[`vercel.json`](vercel.json) configures the Vite output as the browser site and
the Fastify app as a Node.js 22 catch-all function under `/api/v1/*`. The
application is stateless and does not require secrets or environment
variables.

With the Vercel CLI authenticated:

```sh
vercel link --yes
vercel deploy
vercel inspect <preview-url>
curl <preview-url>/api/v1/health
curl <preview-url>/
vercel deploy --prod
```

Validate the preview before promoting it. Vercel deployment does not imply
support for unbounded searches or long-lived jobs; the same conservative API
limits apply in production.

## Determinism and limits

Determinism is defined over the validated JSON request and engine version:

- logical ticks replace wall-clock time;
- entity IDs are sequential and never overwrite existing IDs;
- event order is logical step, priority, then insertion sequence;
- rules and entities use locale-independent ordering;
- the seed is preserved as a reproducibility input;
- the engine version is recorded and replay rejects unsupported versions.

`maxSteps`, `maxEvents`, and `maxEntities` are logical safety limits. A run is
`completed` only after its event queue is exhausted. A run that hits a budget is
`limit-exhausted` with a reason such as `max-steps`, `max-events`, or
`max-entities`.

## Known limitations

- The world model is intentionally small; there is no networking, persistence,
  spatial index, or continuous backend physics.
- The current rule vocabulary has no random effect, so the seed does not yet
  alter outcomes.
- Exhaustive search is intended for small catalogues. Larger spaces need a
  separately specified strategy such as beam search or branch-and-bound.
- Replay verification compares deterministic data but is not cryptographic
  authenticity proof.
- The HTTP API is synchronous at the request boundary. Larger experiments need
  a persistent job architecture that is not implemented here.
- The frontend is a focused vertical slice with two campaign challenges, one
  sandbox world, one compiler objective, and one replay inspector.

## Project status

Rule Riot is an actively developed open-source buildathon project. The current
production slice is intentionally small: it favors reproducibility, explicit
limits, inspectable traces, and honest outcomes over a large content surface.

If you find a bug, include the smallest reproducible JSON request, engine
version, command used, and observed result. Do not include secrets or private
environment files in an issue or pull request.
