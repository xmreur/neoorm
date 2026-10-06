# AGENTS.md — working in this repo

## Layout

- `src/`: runtime, query compiler, schema DSL, codegen, dialects, Studio server.
- `test/`: vitest suites, including `.test-d.ts` type tests (checked by `tsc`, not vitest).
- `docs/`: human docs and the source of truth for `llms-full.txt`.
- `examples/blog`: realistic schema plus query examples.
- `scripts/`: bun scripts (`studio-dev.ts`, `generate-llms.ts`).
- `dist/`: build output — never edit by hand.
- `studio-web/`: separate Vite app with its own tsconfig.

## Commands (bun)

- `bun install --frozen-lockfile` after pulling.
- `bun run build` — compile plus Studio UI build.
- `bun run typecheck` — `tsc` on the repo plus `studio-web`.
- `bun run lint` — `biome check .` (must pass clean).
- `bun run test` — full vitest run; `bunx vitest run <path>` for a single file.
- `bun run docs:llms` — regenerate `llms-full.txt` after touching `docs/`.
- `bun run dist/bin/neoorm.js generate [--name <name>]` — regenerate the example client (`--name` only when a migration is created; CI passes `--name ci`).

## Code conventions

- Tabs, double quotes — enforced by biome; run the linter instead of hand-formatting.
- Strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`): handle `undefined` explicitly, no non-null shortcuts in new code.
- `tsconfig.json` maps `neoorm/*` to `src/*` — examples and tests import through those paths.
- Verify your own work by executing it: reproduce first, then run the relevant tests plus `typecheck` and `lint`.

## Branches, commits, PRs

- Branches: `feat/*`, `fix/*`, `perf/*`, `docs/*`.
- Commits: `feat:`, `fix:`, `chore:` prefixes (`chore: release vX.Y.Z` for releases).
- Merge to `main` via pull request; keep PRs focused on one change.

## Testing notes

- SQLite suites run in-memory locally — prefer them for new query-compiler tests.
- Postgres/MySQL/MariaDB suites `skipIf` without `DATABASE_URL` / `MYSQL_URL` / `MARIADB_URL`; CI provides live services, so don't worry about those skips locally.
- `.test-d.ts` files assert types via `@ts-expect-error`: an "unused `@ts-expect-error`" failure means the bad code now compiles — intended only when a type was deliberately widened.

## Gotchas

- After editing `docs/*.md`, regenerate `llms-full.txt` (`bun run docs:llms`) — CI fails otherwise. Never edit `llms-full.txt` by hand.
- `studio-web/` has its own tsconfig (`bun run studio:typecheck` covers it).
- Live-DB tests share one database per file when env vars are set, so keep test files self-isolated (see `vitest.config.ts`).
