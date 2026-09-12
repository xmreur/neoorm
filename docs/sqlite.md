# SQLite

SQLite is a first-class dialect for local development, testing, and single-file deployments. Everything in the schema DSL, codegen, migrations, and query client works against SQLite with no extra database server.

## Requirements

NeoOrm requires **Node.js 22.5+** or **Bun**. No SQLite package is required — auto-open uses the driver bundled with your runtime:

| Runtime | Driver |
|---------|--------|
| Node.js 22.5+ | built-in `node:sqlite` (`DatabaseSync`) |
| Bun | `bun:sqlite` |
| Custom | pass your own `db` instance (see [Custom driver](#custom-driver)) |

If none is available, creating a client throws: `No SQLite driver available. Provide a db instance, or run on Bun or Node.js 22.5+`.

## Configuration

Set `provider: "sqlite"` and point `url` at a file path or `:memory:`:

```ts
// neoorm.config.ts
import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: {
    provider: "sqlite",
    url: "./dev.db", // or ":memory:"
  },
});
```

`datasource.schema` and `datasource.enum: "native"` are PostgreSQL-only and ignored/unsupported on SQLite. Enums always use the `check` (or `union`) TEXT storage mode.

## Runtime client

```ts
import { createNeoOrmClient } from "neoorm";
import { manifest } from "./neoorm/manifest.js";

const db = createNeoOrmClient(manifest, {
  provider: "sqlite",
  databasePath: "./dev.db",
});
```

Use `databasePath: ":memory:"` for an in-memory database (one connection, no persistence).

Wrapping a connection sets `PRAGMA foreign_keys = ON`, `busy_timeout = 5000`, and `journal_mode = WAL` (WAL is a no-op for `:memory:`). Opt out per client:

```ts
const db = createNeoOrmClient(manifest, {
  provider: "sqlite",
  databasePath: "./dev.db",
  sqlite: { wal: false, busyTimeout: false },
});
```

`busyTimeout` can also be a millisecond wait (`sqlite: { busyTimeout: 10_000 }`).

### Custom driver

Pass any object implementing `prepare(sql)`, `exec(sql)`, and `close()` — the `node:sqlite` and `bun:sqlite` APIs both match. Useful for sandboxed runtimes or existing database handles:

```ts
import { DatabaseSync } from "node:sqlite";
import { createNeoOrmClientFromSqlite } from "neoorm";
import { manifest } from "./neoorm/manifest.js";

const database = new DatabaseSync("./dev.db");
const db = createNeoOrmClientFromSqlite(manifest, database);
```

`$disconnect()` does not close the handle — call `database.close()` yourself. `createNeoOrmClient(manifest, { db: database })` is the same ownership model.

## CLI

The full CLI works against SQLite:

```bash
bunx neoorm migrate deploy
bunx neoorm db push
bunx neoorm db pull
bunx neoorm migrate status
bunx neoorm migrate reset --force
```

- The migration ledger table is `_neoorm_migrations` (`id INTEGER PRIMARY KEY AUTOINCREMENT`, `name`, `checksum`, `applied_at`). `migrate deploy` wraps the run in `BEGIN IMMEDIATE` and refuses an edited `migration.sql` whose checksum no longer matches the ledger.
- `migrate reset` drops all non-`sqlite_` tables (there is no schema concept).
- `db pull` introspects `sqlite_master` back into a schema file.

## Type mapping

| Schema builder | SQLite storage |
|----------------|----------------|
| `id`, `text`, `uuid`, `json`, `jsonb`, `decimal`, `textArray`, `intArray`, `citext`, `enumType` | `TEXT` |
| `int`, `serial` | `INTEGER` |
| `bigint` | `TEXT` |
| `serial().primary()` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `bool` | `BOOLEAN` (stored as 0/1) |
| `timestamp` | `TEXT` (ISO-8601) |
| `bytea` | `BLOB` |
| `fk` | the target column's type (default `TEXT`) |

`defaultNow()` compiles to `CURRENT_TIMESTAMP`. Structural table changes that SQLite cannot do in place (column type changes, FK changes, nullability) are applied via a table-rebuild strategy: `PRAGMA foreign_keys = OFF`, then in one transaction create `__neoorm_<table>_new`, copy rows, drop the old table, rename, and `PRAGMA foreign_keys = ON`. Foreign keys must be disabled *before* `BEGIN` — SQLite ignores that pragma inside a transaction. The client always enables `foreign_keys` at connect time, so inbound FKs (e.g. `posts.user_id` → `users`) would otherwise block `DROP TABLE` of the parent.

## Differences from PostgreSQL

| Feature | PostgreSQL | SQLite |
|---------|-----------|--------|
| `distinct` (`DISTINCT ON`) | supported | throws `distinct is not supported on SQLite` |
| `datasource.schema` | multi-schema | not applicable |
| `enum: "native"` | `CREATE TYPE ... AS ENUM` | not applicable (TEXT + CHECK) |
| transaction options (`readOnly`, `isolationLevel`) | `BEGIN READ ONLY` / `ISOLATION LEVEL` | `readOnly` → `PRAGMA query_only`; `RepeatableRead`/`Serializable` → `BEGIN IMMEDIATE`; other isolation → `BEGIN` |
| JSON operators | `@>`, `?`, `#>` | `json_patch` / `json_each` / `json_extract` |

Everything else — relations, nested writes, cursor pagination, aggregates, `groupBy`, upsert, `findOrCreate`, savepoint-based nested transactions — behaves identically.
