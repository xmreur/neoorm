# MySQL

MySQL 8.0+ is a first-class dialect via the optional `mysql2` driver. Schema DSL, codegen, migrations, and the query client work against MySQL the same way they do against PostgreSQL, with the storage and SQL differences below.

PlanetScale, MySQL 5.7, and GIS/PostGIS are out of scope.

## Requirements

Install the driver next to NeoOrm:

```bash
bun add neoorm mysql2
```

If `mysql2` is missing, creating a client throws: `mysql2 is not installed. Run: bun add mysql2`.

## Configuration

Set `provider: "mysql"` and a MySQL 8 connection URL:

```ts
// neoorm.config.ts
import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: {
    provider: "mysql",
    url: process.env.DATABASE_URL ?? "mysql://root@localhost:3306/myapp",
  },
});
```

`datasource.schema` is ignored (the database comes from the URL). `datasource.enum: "native"` is allowed and emits column `ENUM('a','b')` — there is no `CREATE TYPE`.

## Runtime client

```ts
import { createNeoOrmClient } from "neoorm";
import { manifest } from "./neoorm/manifest.js";

const db = createNeoOrmClient(manifest, {
  provider: "mysql",
  connectionString: process.env.MYSQL_URL,
});
```

Wrap an existing `mysql2/promise` pool with `createNeoOrmClientFromMysql(manifest, pool)`. `$disconnect()` does not call `pool.end()` in that case — you own the pool.

Data queries use mysql2 `execute()` (binary prepared statements, cached per connection). Transaction control (`START TRANSACTION`, `COMMIT`, `SAVEPOINT`) stays on `query()`. Pools you wrap without `execute` fall back to `query()`.

Owned pools from `createNeoOrmClient` accept the same `pool` object as PostgreSQL for shared fields (`max`, idle timeout, keep-alive). Default `max` is 10 (`connectionLimit`). PostgreSQL-only keys such as `statement_timeout` are ignored.

```ts
const db = createNeoOrmClient(manifest, {
  provider: "mysql",
  connectionString: process.env.MYSQL_URL,
  pool: {
    max: 10,
    idleTimeoutMillis: 10_000,
    keepAlive: true,
  },
});
```

Standalone `neoorm/sql` (`sqlId`) stays ANSI-quoted (`"users"`). Use `db.sql` with `db.sqlId("users")` so identifiers are backticks on MySQL.

`mysqlDialect` is exported from `neoorm` for `dbPush`, migrate helpers, and custom executor wiring.

## CLI

```bash
bunx neoorm init --provider mysql
bunx neoorm migrate deploy
bunx neoorm db push
bunx neoorm db pull
bunx neoorm migrate status
bunx neoorm migrate reset --force
```

- Deploy lock is `GET_LOCK('neoorm.migrate.<db>', timeout)` / `RELEASE_LOCK` on the deploy transaction.
- `migrate reset` sets `FOREIGN_KEY_CHECKS=0`, drops all tables in the current database, then re-enables checks and re-applies migrations.
- `db pull` introspects `information_schema` back into a schema file.

## Type mapping

| Schema builder | MySQL storage |
|----------------|---------------|
| `id()`, unique/PK `text` | `VARCHAR(191)` (InnoDB index prefix; `TEXT` cannot be a unique key) |
| `text()` otherwise | `TEXT`, or `VARCHAR(n)` with `.maxLength()` |
| `uuid()` | `CHAR(36)` |
| `bool()` | `TINYINT(1)` |
| `int()` | `INT` |
| `bigint()` | `BIGINT` |
| `real()` / `float()` | `FLOAT` |
| `double()` | `DOUBLE` |
| `serial()` | `INT NOT NULL AUTO_INCREMENT` |
| `timestamp()` | `DATETIME(6)` + `CURRENT_TIMESTAMP(6)` |
| `date()` | `DATE` |
| `time()` | `TIME` |
| `json()` / `jsonb()` | `JSON` |
| `decimal()` | `DECIMAL(p,s)` |
| `money()` | `DECIMAL(19,4)` |
| `xml()` | `LONGTEXT` |
| `bytea()` | `BLOB` |
| arrays / `citext()` | `JSON` / `VARCHAR` + `utf8mb4_0900_ai_ci` |
| `interval()`, `inet()`, `cidr()`, ranges | rejected at schema compile |
| `enum: "check"` | `VARCHAR` + `CHECK` (8.0.16+) |
| `enum: "native"` | column `ENUM('a','b')` |

## Differences from PostgreSQL

| Feature | PostgreSQL | MySQL |
|---------|------------|--------|
| Identifier quoting | `"users"` | `` `users` `` |
| `RETURNING` | native | follow-up `SELECT` (or `insertId` for serial) |
| `upsert` | `ON CONFLICT … DO UPDATE` | `INSERT … AS new ON DUPLICATE KEY UPDATE` |
| `skipDuplicates` | `ON CONFLICT DO NOTHING` | `INSERT IGNORE` |
| `findOrCreate` | `xmax = 0` | SELECT → INSERT → retry on unique violation |
| `in` / `notIn` | array bind | `IN (?, …)` up to 256 values; `JSON_TABLE` above that |
| `search` | POSIX `~` | `REGEXP_LIKE` |
| `ilike` | `ILIKE` | `LOWER(col) LIKE LOWER(?)` |
| JSON operators | `@>`, `?`, `#>` | `JSON_CONTAINS` / `JSON_EXTRACT` / `JSON_CONTAINS_PATH` |
| Nested includes | `json_agg … FILTER` | `JSON_ARRAYAGG(CASE WHEN …)` |
| `distinct` (`DISTINCT ON`) | supported | throws |
| Partial indexes `index({ where })` | supported | rejected at schema compile |
| PostGIS | supported | rejected |
| `interval` / `inet` / `cidr` / range types | supported | rejected at schema compile |
| `datasource.schema` | multi-schema | ignored (URL database) |

`createManyAndReturn` for serial primary keys uses `LAST_INSERT_ID()` plus row count inside a transaction and assumes consecutive autoincrement values.

Offset pages (`findMany({ take, skip })`) are `LIMIT`/`OFFSET`; `paginate` stays cursor-based.

Everything else — relations, nested writes, cursor pagination, aggregates, `groupBy`, savepoint-based nested transactions — behaves the same as on PostgreSQL.
