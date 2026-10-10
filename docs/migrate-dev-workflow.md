# `migrate dev` Workflow

This guide records the workflow contract and the implementation changes behind `neoorm migrate dev`. The refactor preserves the command's migration order and user-visible output timing.

## Runtime contract

`runMigrateDev` derives `migrationsDir` from `outDir` and runs the complete sequence inside `withMigrateDevLock`:

1. Read the snapshot, compile the target schema, reconcile pending `CREATE TABLE` migrations against the live database, then apply remaining pending migrations.
2. Generate from the current schema. If generation fails with the existing missing-migration-name error, no explicit name was supplied, and the CLI provided an interactive prompt callback, ask once and retry once. Other errors propagate unchanged. If generation needs no migration, it does not prompt.
3. Emit the generation summary and warnings, then reconcile a newly written migration against existing tables or apply it when reconciliation did not record it.
4. Return whether destructive changes were blocked; the CLI sets `process.exitCode` after the workflow completes.

The lock covers snapshot reading, both reconciliation/deployment phases, generation, and the optional prompt. Progress events keep the CLI output at the same stage as before: pending-migration output precedes a possible prompt, while generation output precedes post-generation reconciliation/application.

## File-by-file changes

### `src/migrate/dev-workflow.ts`

- **Before:** The ordered `migrate dev` sequence had no dedicated workflow module; the CLI path coordinated it.
- **After:** `runMigrateDev` owns snapshot reading, initial reconciliation/deployment, generation, the optional one-shot prompt/retry, and post-generation reconciliation/deployment. A typed progress-event union reports completed stages, while existing migration and code-generation helpers remain responsible for their work. The migration directory is derived from `outDir`.
- **Why it is useful:** The lock scope and ordering have one owner, and the workflow can be tested through a small interface without a CLI/TTY harness.

### `src/bin/neoorm.ts`

- **Before:** The CLI command path contained the `migrate dev` orchestration alongside the separate `migrate deploy` path.
- **After:** `migrate dev` calls `runMigrateDev`, adapts its progress events to the existing console output, supplies the prompt callback only for interactive runs, and handles the returned destructive-blocked status. `migrate deploy` remains on its separate path.
- **Why it is useful:** Terminal interaction and presentation stay in the CLI, while moving orchestration does not delay or reorder output around the prompt.

### `src/codegen/generate.ts`

- **Before:** The missing-migration-name predicate lived in the CLI even though both regular `generate` and `migrate dev` use it.
- **After:** The same predicate lives beside `missingMigrationNameError` in the code-generation module and is shared by both callers.
- **Why it is useful:** There is one definition of the narrow prompt-eligibility check; its error conditions are unchanged, not broadened into general error handling.

### `test/migrate-dev-workflow.test.ts`

- **Before:** Existing tests covered migration, generation, and lock helpers separately, but not their ordering at the workflow boundary.
- **After:** Real in-memory SQLite tests verify that a pending migration is applied and the lock remains held when the controlled name prompt runs, and that an unchanged schema completes without prompting or creating another migration.
- **Why it is useful:** The regression coverage checks observable database state and timing rather than mocked helper forwarding or CLI wiring.

### `docs/migrations.md`

- **Before:** The migration guide described command behavior but did not state the full `migrate dev` lock interval.
- **After:** It documents that the lock starts before pending reconciliation and remains held through the optional name prompt, generation, and post-generation reconciliation/application; it links to this implementation guide.
- **Why it is useful:** Readers can reason about concurrency and prompt timing from the documented contract.

### `llms-full.txt`

- **Before:** The generated documentation aggregate did not include the updated lock-lifetime note or this guide.
- **After:** Regeneration mirrors the migration-guide update and includes the new workflow page.
- **Why it is useful:** The aggregate stays aligned with the source documentation instead of presenting stale workflow details.

### `examples/blog/seed.ts`

- **Before:** The schema was imported as a runtime value even though it was used only for a type.
- **After:** The import is type-only.
- **Why it is useful:** TypeScript erases the import from emitted JavaScript, and lint no longer reports the type-only usage.

### `docs/migrate-dev-workflow.md`

- **Before:** There was no durable, file-by-file record of the workflow ownership, preserved behavior, and verification.
- **After:** This page records the execution contract, concrete before/after changes, and their rationale.
- **Why it is useful:** Future maintenance can distinguish an ownership refactor from an intended behavior change.

## Preserved behavior and scope

- Pending migrations are reconciled and applied before a missing name can be requested.
- The prompt is limited to the existing missing-name condition and is attempted at most once; unchanged schemas do not prompt.
- The migrate-dev lock remains held during the prompt and until post-generation reconciliation/application finishes.
- The existing second schema compilation remains; this change does not optimize it.
- `migrate deploy` keeps its separate execution path.

## Verification

The implementation verification below was recorded before this documentation continuation; it was not rerun as part of the documentation-only changes:

- `bun run build` — passed.
- `bun run test` — 128 files passed, 4 skipped; 1,215 tests passed, 42 skipped.
- `bun run typecheck` and `bun run lint` — passed; lint was clean.
- Focused migration suites — 4 files and 34 tests passed.
- CLI fixture smoke — `migrate dev --name initial`, a no-name no-op `migrate dev`, and a no-op `migrate deploy` each exited 0; the SQLite database had the expected table and one applied ledger entry.

The generated documentation is refreshed with `bun run docs:llms` after editing this page.
