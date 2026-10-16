# Rule Riot backend

Rule Riot is a deterministic, open-source simulation engine that searches
combinations of validated state-transition rules and records the causal events
behind interesting outcomes. This repository contains the backend only; no
frontend is included.

## Phase 1 architecture

The backend is a small TypeScript/Node.js application with these planned
boundaries:

- `src/domain/` — typed world state, events, rules, objectives, and result
  contracts.
- `src/rules/` — rule vocabulary validation and deterministic rule matching.
- `src/simulation/` — bounded event scheduling and state transitions.
- `src/search/` — candidate generation, objective scoring, and search budgets.
- `src/trace/` — canonical event traces and deterministic replay verification.
- `src/cli.ts` — JSON-oriented command-line boundary for the real engine.
- `test/` — unit and end-to-end tests that exercise the production modules.

Key invariants are deterministic ordering, validated data-only rules (never
`eval` or arbitrary code), explicit event/entity/step budgets, causal parent
references for generated events, and honest termination statuses.

The implementation is intentionally being delivered in phases. Phase 1 sets
up the pinned TypeScript project and the test/build commands; later commits add
the simulation, search, trace, replay, and CLI behavior.

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

At this phase the repository has no API or discovery command yet. Those are
added only when their real implementations are available.
