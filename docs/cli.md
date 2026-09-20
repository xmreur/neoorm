# CLI reference

Commands that read `neoorm.config.ts` load `.env` from the current working directory first. Existing environment variables take precedence.

## `neoorm init`

Scaffold a new NeoOrm project.

```
neoorm init [options]
```

Creates `neoorm.config.ts`, `schema.ts`, and `.env.example` only — no codegen or migrations. Run `neoorm migrate dev` afterwards to generate the client and first migration.

On a TTY, `neoorm init` opens a Clack wizard (provider, database URL, schema path, output directory). If any scaffold files already exist, it asks before overwriting. Ctrl+C cancels. Flags skip the matching step. In CI / non-TTY, it uses defaults and fails if files already exist unless `--force` is passed.

Options:
- `--provider <provider>` — `postgresql` (default), `sqlite`, `mysql`, or `mariadb`. `postgres` and `pg` are aliases of `postgresql`. If omitted on a TTY, prompts to choose.
- `--database-url <url>` — override database URL / file path (default: `postgresql://postgres:postgres@localhost:5432/myapp` for postgres, `./dev.db` for sqlite, `mysql://root@localhost:3306/myapp` for mysql, `mariadb://root@localhost:3306/myapp` for mariadb)
- `--schema <path>` — schema file path (default: `./schema.ts`). Must end in `.ts`, `.mts`, or `.cts`.
- `--out <dir>` — generated output directory (default: `./neoorm`). Cannot be the same path as the schema file.
- `--force` — overwrite existing scaffold files without confirming

## `neoorm generate`

Generate manifest, typed client, models, includes, and migrations from your schema. With `generate.zod` in config, also writes `out/zod.ts` (install `zod` `^4`; generate warns if it is missing). With `generate.typebox`, also writes `out/typebox.ts` (install `typebox` `^1`; generate warns if it is missing). With `generate.elysia`, also writes `out/elysia.ts` (install `elysia` `>=1.2`; generate warns if it is missing).

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

Drop the `public` schema (PostgreSQL) or all tables (SQLite, MySQL, and MariaDB) and re-apply all migrations.

```
neoorm migrate reset --force [--skip-apply]
```

- `--force` — required (safety guard)
- `--skip-apply` — only drop, don't re-apply

PostgreSQL: the connecting role owns the recreated schema. `PUBLIC` is not granted.

## `neoorm docs`

Serve the NeoOrm documentation locally in your browser.

```
neoorm docs [options]
```

Options:
- `-p, --port <port>` — port to listen on (default: `7583`)
- `-H, --host <host>` — host to bind (default: `127.0.0.1`)
- `--open` — open the docs site in your default browser

The sidebar includes a search box with live results across all documentation pages.

## `neoorm studio`

Browse and edit data in a local Studio UI (spreadsheet grid, SQL console, query playground, schema explorer, ER graph, migrate status).

```
neoorm studio [options]
```

Options:
- `-p, --port <port>` — port to listen on (default: `7584`)
- `-H, --host <host>` — host to bind (default: `127.0.0.1`)
- `--open` — open Studio in your default browser
- `--read-only` — block row mutations and non-read SQL
- `--verbose` — log SQL statements executed by Studio
- `--token <token>` — require this token for API access (generated automatically when binding a non-loopback host)

See [Studio](studio.md) for features, keyboard shortcuts, and security notes.

## `neoorm db push`

Push the current `schema.ts` to the database without going through the migration ledger. You do not need to run `generate` first — push compiles the schema file you just saved. After a successful push, `snapshot.json` is updated so later `generate` does not emit the same DDL again.

```
neoorm db push
```

## `neoorm db pull`

Introspect the database and write a schema file.

```
neoorm db pull
```
