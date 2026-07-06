# CLI reference

## `neoorm init`

Scaffold a new NeoOrm project.

```
neoorm init [options]
```

Creates `neoorm.config.ts`, `schema.ts`, `.env.example`, generates the client, and writes the first migration.

## `neoorm generate`

Generate manifest, typed client, models, includes, and migrations from your schema.

```
neoorm generate [options]
```

Options:
- `--accept-data-loss` — include destructive DDL changes (column drops, type changes)

## `neoorm migrate dev`

Apply pending migrations, then generate a new migration if the schema changed.

```
neoorm migrate dev
```

## `neoorm migrate deploy`

Apply all pending migrations.

```
neoorm migrate deploy
```

## `neoorm migrate status`

List applied vs pending migrations.

```
neoorm migrate status
```

Shows timestamps, pending folders on disk, and warnings for applied migrations missing on disk.

## `neoorm migrate down`

Roll back the most recently applied migration(s).

```
neoorm migrate down [--steps N]
```

- `--steps` — number of migrations to roll back (default: 1)

Requires `down.sql` and `snapshot.before.json` in each migration folder (written automatically by `neoorm generate` and `neoorm migrate dev`).

## `neoorm migrate reset`

Drop the `public` schema and re-apply all migrations.

```
neoorm migrate reset --force [--skip-apply]
```

- `--force` — required (safety guard)
- `--skip-apply` — only drop, don't re-apply

## `neoorm db push`

Push the current snapshot schema to the database without going through the migration ledger.

```
neoorm db push
```

## `neoorm db pull`

Introspect the database and write a schema file.

```
neoorm db pull
```
