# Migrations

## Commands

| Command | Description |
|---------|-------------|
| `neoorm init` | Scaffold `neoorm.config.ts`, `schema.ts`, `.env.example` only (no codegen or migrations; run `neoorm migrate dev` after) |
| `neoorm generate [--name <name>]` | Emit manifest, typed client, models, includes, and migrations (`--name` only when a migration is created) |
| `neoorm migrate dev [--name <name>]` | Apply pending migrations (or record colliding CREATE TABLE files against the live schema), then generate a new one if `schema.ts` changed (`--name` only when a new migration is created) |
| `neoorm migrate diff [--accept-data-loss] [--json]` | Preview the SQL a new migration would contain — no files written, no `--name` needed |
| `neoorm migrate deploy` | Apply pending migrations (throws `migration_drift` if a pending `CREATE TABLE` targets a relation that already exists) |
| `neoorm migrate status` | List applied vs pending migrations |
| `neoorm migrate down [--steps N]` | Roll back the last N applied migrations (default 1) |
| `neoorm migrate reset --force` | Drop the `public` schema (PostgreSQL) or all tables (SQLite / MySQL / MariaDB) and re-apply migrations (local dev) |
| `neoorm db push` | Push the current `schema.ts` to the database (no migration file) |
| `neoorm db pull` | Introspect the database into a schema file |

## Generate outcomes

`neoorm generate` always refreshes generated TypeScript files. It prints one of four outcomes:

| Outcome | Meaning |
|---------|---------|
| Schema unchanged | Snapshot hash matches — no manifest or migration changes |
| Client regenerated | Manifest changed but no database DDL needed |
| Migration created | New `migrations/<timestamp>_<name>/migration.sql` written |
| Migration blocked | Destructive or manual changes prevented writing SQL |

Migration names are slugified (`Add Users` → `add_users`, capped at 50 chars) and prefixed with a timestamp so folders sort in apply order. `--name` is only needed when a migration is created: the CLI prompts on a TTY at that point (after pending migrations are applied in `dev`) and errors in non-interactive runs. Runs with no schema changes (client regeneration only) and pending-apply-only `dev` runs succeed without `--name` and never prompt. Older `*_migration` folders still apply in order.

`migrate dev` holds its lock from before pending reconciliation through the optional name prompt, generation, and post-generation reconciliation/application.
For the implementation ordering and regression coverage, see [the workflow guide](migrate-dev-workflow.md).

When migration is blocked, the CLI explains why. Re-run with `--accept-data-loss` to include destructive DDL such as table and column drops:

```bash
neoorm generate --name add_users --accept-data-loss
```

Appending a native enum value is ordinary DDL: `ALTER TYPE … ADD VALUE` on PostgreSQL, and `MODIFY … ENUM(...)` on MySQL and MariaDB. Removing or reordering values stays blocked after `--accept-data-loss`, and so do primary key changes (`primaryKey()` or a `.primary()` toggle), unsafe column type changes, `ADD COLUMN … NOT NULL` without a default, and `SET NOT NULL`. Generate writes no SQL for those and leaves `snapshot.json` unchanged. Dropping the last use of a PostgreSQL enum emits `DROP TYPE` after the column or table that used it is dropped. A default makes the new column safe on existing rows. `SET NOT NULL` needs a hand-written migration that updates existing nulls first. Renaming a table's SQL name while keeping its accessor emits `ALTER TABLE … RENAME TO` and keeps the rows. It is not a drop. Indexes keep their shape and are renamed with the table (`posts_title_idx` becomes `articles_title_idx`), so a later drop uses the name that exists in the database. SQLite has no `RENAME INDEX`, so that rename is a drop of the old name and a create of the new one. Changing `datasource.schema` moves the tables and existing enum types into the new schema instead of leaving them in `public`. Index and enum statements in a non-public schema are schema-qualified.

To inspect the SQL before naming the migration, preview it first (read-only, needs no `--name`):

```bash
neoorm migrate diff
neoorm migrate diff --json
```

## Existing tables vs pending CREATE TABLE

`generate` diffs `snapshot.json`. If that file is missing, the first migration is a full `CREATE TABLE` script. `migrate deploy` will not run that SQL when those relations already exist (for example after `db push`). It throws `migration_drift` before any user statement.

`neoorm migrate dev` detects the same collision, diffs the live database to `schema.ts`, applies that catch-up SQL (often none, sometimes `ALTER`), records the pending files in `_neoorm_migrations` using the on-disk checksums, and writes `snapshot.json`. Destructive catch-up still requires `--accept-data-loss`. Empty databases still run `CREATE TABLE` as before.

## Deploy locking and checksums

`neoorm migrate deploy` serializes concurrent runs and records a SHA-256 checksum of each applied `migration.sql`:

| Dialect | Lock |
|---------|------|
| PostgreSQL | `pg_advisory_xact_lock` on the deploy transaction |
| SQLite | `BEGIN IMMEDIATE` around the whole deploy (after `PRAGMA foreign_keys = OFF`) |
| MySQL | `GET_LOCK('neoorm.migrate.<db>', timeout)` / `RELEASE_LOCK` on the deploy connection |
| MariaDB | `GET_LOCK('neoorm.migrate.<db>', timeout)` / `RELEASE_LOCK` on the deploy connection |

The ledger table `_neoorm_migrations` stores `name`, a SHA-256 `checksum` of `migration.sql`, and `down_checksum` for `down.sql`. Deploy refuses a missing `migration.sql`, a null checksum, or a checksum that does not match the file. It also refuses a pending migration that sorts before one already applied, so an earlier file cannot run after a later one. `migrate down` runs `down.sql` only when its checksum matches the value stored at apply time.

PostgreSQL and SQLite apply pending files inside the deploy lock transaction: if a later statement fails, none of that run's new ledger rows remain. MySQL and MariaDB cannot roll back InnoDB DDL (`CREATE TABLE`, `ALTER`, `CREATE INDEX`) — each statement autocommits. After each committed statement, deploy records the count in `_neoorm_migration_progress`. The ledger row is inserted when the file finishes, and that progress row is removed. The next deploy skips the recorded statements and continues. A changed `migration.sql` is refused while progress for that file exists. `GET_LOCK` is session-scoped and still serializes concurrent deploys; migration SQL does not run under a savepoint. A `MODIFY` that clears a column default does not also emit `ALTER COLUMN … DROP DEFAULT`, because the `MODIFY` already restates the column without one.

## Status

```bash
neoorm migrate status
```

Shows applied migrations (with timestamps), pending folders on disk, and warnings for drift (applied in DB but missing on disk).

## Reset

```bash
neoorm migrate reset --force
```

Drops the `public` schema (PostgreSQL) or all tables (SQLite, MySQL, and MariaDB) and re-applies all migrations from disk. Requires `--force`. Use `--skip-apply` to only drop without re-applying.

PostgreSQL reset recreates the schema owned by the connecting role. It does not `GRANT ALL ON SCHEMA … TO PUBLIC`.

## Rollback

`down.sql` and `snapshot.before.json` are written when `neoorm generate` or `neoorm migrate dev` creates a migration whose reverse diff is complete. The down SQL is the reverse schema diff (`next → prev`), with destructive changes accepted so rollbacks can drop columns or tables added in the forward migration. If that reverse needs a manual change — adding back a `NOT NULL` column with no default, setting `NOT NULL`, or another change `--accept-data-loss` does not emit — NeoORM writes neither file. `migrate down` then refuses the rollback and leaves `snapshot.json` unchanged.

```bash
neoorm migrate down
neoorm migrate down --steps 2
```

Rolls back the most recently applied migration(s) by running each migration folder's `down.sql`, removing the ledger entry from `_neoorm_migrations`, and restoring `snapshot.json` from `snapshot.before.json`. A `down.sql` that omitted a manual change is refused before any SQL runs, and `snapshot.json` stays as it is.

Legacy migrations without `down.sql` cannot be rolled back — re-generate the migration or add `down.sql` manually.

Migration folders are not deleted on rollback (same as Prisma). Re-run `neoorm migrate deploy` to re-apply rolled-back migrations.

After rollback, `schema.ts` may still describe a newer schema than the restored snapshot; `neoorm migrate dev` may generate a new forward migration. `db push` and `migrate down` are independent — push ignores the migration ledger. `db push` compiles `schema.ts` (not `snapshot.json`) and updates `snapshot.json` after a successful push so a later `generate` does not emit DDL already applied to the database.

For a full wipe during local development, use `neoorm migrate reset --force` instead.
