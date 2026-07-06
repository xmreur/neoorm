# Migrations

## Commands

| Command | Description |
|---------|-------------|
| `neoorm init` | Scaffold `neoorm.config.ts`, `schema.ts`, `.env.example`, generate client, and first migration |
| `neoorm generate` | Emit manifest, typed client, models, includes, and migrations |
| `neoorm migrate dev` | Apply pending migrations, then generate a new one if the schema changed |
| `neoorm migrate deploy` | Apply pending migrations |
| `neoorm migrate status` | List applied vs pending migrations |
| `neoorm migrate down [--steps N]` | Roll back the last N applied migrations (default 1) |
| `neoorm migrate reset --force` | Drop public schema and re-apply migrations (local dev) |
| `neoorm db push` | Push the current snapshot schema to the database |
| `neoorm db pull` | Introspect the database into a schema file |

## Generate outcomes

`neoorm generate` always refreshes generated TypeScript files. It prints one of four outcomes:

| Outcome | Meaning |
|---------|---------|
| Schema unchanged | Snapshot hash matches — no manifest or migration changes |
| Client regenerated | Manifest changed but no database DDL needed |
| Migration created | New `migrations/<timestamp>/migration.sql` written |
| Migration blocked | Destructive or manual changes prevented writing SQL |

When migration is blocked, the CLI explains why — for example unsupported type casts (`alter_column_type_manual`), enum value changes, or destructive drops. Re-run with `--accept-data-loss` to include destructive DDL:

```bash
neoorm generate --accept-data-loss
```

## Status

```bash
neoorm migrate status
```

Shows applied migrations (with timestamps), pending folders on disk, and warnings for drift (applied in DB but missing on disk).

## Reset

```bash
neoorm migrate reset --force
```

Drops the `public` schema and re-applies all migrations from disk. Requires `--force`. Use `--skip-apply` to only drop the schema without re-applying.

## Rollback

`down.sql` and `snapshot.before.json` are written automatically when `neoorm generate` or `neoorm migrate dev` creates a migration. The down SQL is the reverse schema diff (`next → prev`), with destructive changes accepted so rollbacks can drop columns or tables added in the forward migration.

```bash
neoorm migrate down
neoorm migrate down --steps 2
```

Rolls back the most recently applied migration(s) by running each migration folder's `down.sql`, removing the ledger entry from `_neoorm_migrations`, and restoring `snapshot.json` from `snapshot.before.json`.

Legacy migrations without `down.sql` cannot be rolled back — re-generate the migration or add `down.sql` manually.

Migration folders are not deleted on rollback (same as Prisma). Re-run `neoorm migrate deploy` to re-apply rolled-back migrations.

After rollback, `schema.ts` may still describe a newer schema than the restored snapshot; `neoorm migrate dev` may generate a new forward migration. `db push` and `migrate down` are independent — push ignores the migration ledger.

For a full wipe during local development, use `neoorm migrate reset --force` instead.
