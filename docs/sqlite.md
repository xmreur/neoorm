# SQLite

SQLite is a first-class dialect for local development, testing, and single-file deployments. Everything in the schema DSL, codegen, migrations, and query client works against SQLite with no extra database server.

## Requirements

No SQLite package is required — NeoOrm uses the driver bundled with your runtime:

| Runtime | Driver |
|---------|--------|
| Node.js 22.5+ | built-in `node:sqlite` (`DatabaseSync`) |
| Bun | `bun:sqlite` |
| Anything else | pass your own `db` instance (see [Custom driver](#custom-driver)) |

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

### Custom driver

Pass any object implementing `prepare(sql)`, `exec(sql)`, and `close()` — the `node:sqlite` and `bun:sqlite` APIs both match. Useful for sandboxed runtimes or existing database handles:

```ts
import { DatabaseSync } from "node:sqlite";
import { createNeoOrmClient } from "neoorm";
import { manifest } from "./neoorm/manifest.js";

const database = new DatabaseSync("./dev.db");
const db = createNeoOrmClient(manifest, { db: database });
```

## CLI

The full CLI works against SQLite:

```bash
bunx neoorm migrate deploy
bunx neoorm db push
bunx neoorm db pull
bunx neoorm migrate status
bunx neoorm migrate reset --force
```

- The migration ledger table is `_neoorm_migrations` (`id INTEGER PRIMARY KEY AUTOINCREMENT`).
- `migrate reset` drops all non-`sqlite_` tables (there is no schema concept).
- `db pull` introspects `sqlite_master` back into a schema file.

## Type mapping

| Schema builder | SQLite storage |
|----------------|----------------|
| `id`, `text`, `uuid`, `json`, `jsonb`, `decimal`, `textArray`, `intArray`, `citext`, `enumType` | `TEXT` |
| `int`, `serial` | `INTEGER` |
| `serial().primary()` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `bool` | `BOOLEAN` (stored as 0/1) |
| `timestamp` | `TIMESTAMPTZ` (stored as ISO-8601 text) |
| `bytea` | `BLOB` |
| `fk` | the target column's type (default `TEXT`) |

`defaultNow()` compiles to `CURRENT_TIMESTAMP`. Structural table changes that SQLite cannot do in place (column type changes, FK changes) are applied via a table-rebuild strategy: create `__neoorm_<table>_new`, copy rows, drop the old table, rename.

## Differences from PostgreSQL

| Feature | PostgreSQL | SQLite |
|---------|-----------|--------|
| `distinct` (`DISTINCT ON`) | supported | throws `distinct is not supported on SQLite` |
| `datasource.schema` | multi-schema | not applicable |
| `enum: "native"` | `CREATE TYPE ... AS ENUM` | not applicable (TEXT + CHECK) |
| transaction options (`readOnly`, `isolationLevel`) | full | outer `BEGIN` only; nested transactions use savepoints |
| JSON operators | `@>`, `?`, path ops | implemented with `json_each` / `json_object` |

Everything else — relations, nested writes, cursor pagination, aggregates, `groupBy`, upsert, `findOrCreate`, savepoint-based nested transactions — behaves identically.