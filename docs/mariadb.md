# MariaDB

MariaDB 10.11 LTS is a first-class dialect via the optional official `mariadb` connector. Schema DSL, codegen, migrations, and the query client work the same way as PostgreSQL, with the storage and SQL differences below.

MariaDB versions below 10.11, GIS, Galera, and MaxScale specifics are out of scope. MySQL 8 uses a **separate** dialect and the `mysql2` driver — see [MySQL](mysql.md).

## Requirements

Install the driver next to NeoOrm:

```bash
bun add neoorm mariadb
```

If `mariadb` is missing, creating a client throws: `mariadb is not installed. Run: bun add mariadb`.

## Configuration

Set `provider: "mariadb"` and a MariaDB 10.11 connection URL:

```ts
// neoorm.config.ts
import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: {
    provider: "mariadb",
    url: process.env.DATABASE_URL ?? "mariadb://root@localhost:3306/myapp",
  },
});
```

`datasource.schema` is ignored (the database comes from the URL). `datasource.enum: "native"` is allowed and emits column `ENUM('a','b')` — there is no `CREATE TYPE`.

## Runtime client

```ts
import { createNeoOrmClient } from "neoorm";
import { manifest } from "./neoorm/manifest.js";

const db = createNeoOrmClient(manifest, {
  provider: "mariadb",
  connectionString: process.env.MARIADB_URL,
});
```

Wrap an existing `mariadb` pool with `createNeoOrmClientFromMariadb(manifest, pool)`. `$disconnect()` does not call `pool.end()` in that case — you own the pool.

Data queries use connector `execute()` (prepared statements, `prepareCacheLength` 256). Statements with `RETURNING` use `query()` instead: MariaDB’s binary prepare protocol rejects `UPDATE`/`DELETE … RETURNING`. Transaction control stays on `query()`. Pools you wrap without `execute` fall back to `query()`.

Owned pools from `createNeoOrmClient` accept the same `pool` object as PostgreSQL for shared fields (`max`, idle timeout, keep-alive). Default `max` is 10. Pipelining is enabled (commands are still awaited in order). PostgreSQL-only keys such as `statement_timeout` are ignored.

```ts
const db = createNeoOrmClient(manifest, {
  provider: "mariadb",
  connectionString: process.env.MARIADB_URL,
  pool: {
    max: 10,
    idleTimeoutMillis: 10_000,
    keepAlive: true,
  },
});
```

Standalone `neoorm/sql` (`sqlId`) stays ANSI-quoted (`"users"`). Use `db.sql` with `db.sqlId("users")` so identifiers are backticks on MariaDB.

`mariadbDialect` is exported from `neoorm` for `dbPush`, migrate helpers, and custom executor wiring.

## CLI

```bash
bunx neoorm init --provider mariadb
bunx neoorm migrate deploy
bunx neoorm db push
bunx neoorm db pull
bunx neoorm migrate status
bunx neoorm migrate reset --force
```

- Deploy lock is `GET_LOCK('neoorm.migrate.<db>', timeout)` / `RELEASE_LOCK` on the deploy transaction.
- `migrate reset` sets `FOREIGN_KEY_CHECKS=0`, drops all tables in the current database, then re-enables checks and re-applies migrations.
- `db pull` introspects `information_schema`. MariaDB `JSON` columns are often `LONGTEXT` plus a `json_valid()` CHECK; NeoOrm maps those back to `jsonb()`.

## Type mapping

| Schema builder | MariaDB storage |
|----------------|-----------------|
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
| `json()` / `jsonb()` | `JSON` (LONGTEXT + `json_valid()` CHECK under the hood) |
| `decimal()` | `DECIMAL(p,s)` |
| `money()` | `DECIMAL(19,4)` |
| `xml()` | `LONGTEXT` |
| `bytea()` | `BLOB` |
| arrays / `citext()` | `JSON` / `VARCHAR` + `utf8mb4_uca1400_ai_ci` |
| `interval()`, `inet()`, `cidr()`, ranges | rejected at schema compile |
| `enum: "check"` | `VARCHAR` + `CHECK` |
| `enum: "native"` | column `ENUM('a','b')` |

## Differences from MySQL 8

| Feature | MySQL 8 | MariaDB 10.11 |
|---------|---------|----------------|
| Driver | `mysql2` | official `mariadb` package |
| `upsert` | `INSERT … AS new ON DUPLICATE KEY UPDATE` | `ON DUPLICATE KEY UPDATE col = VALUES(col)` |
| `search` | `REGEXP_LIKE` | `col REGEXP $n` (`(?i)` for insensitive) |
| `citext` collation | `utf8mb4_0900_ai_ci` | `utf8mb4_uca1400_ai_ci` |
| CHECK drop | `DROP CHECK` | `DROP CONSTRAINT` |
| CHECK errno | 3819 | 4025 (`ER_CONSTRAINT_FAILED`) |
| JSON storage | native JSON | JSON as LONGTEXT + `json_valid()` |
| `RETURNING` | none | native `INSERT`/`UPDATE`/`DELETE` `RETURNING` |

## Differences from PostgreSQL

| Feature | PostgreSQL | MariaDB |
|---------|------------|---------|
| Identifier quoting | `"users"` | `` `users` `` |
| `RETURNING` | native | native `INSERT`/`UPDATE`/`DELETE` `RETURNING` |
| `upsert` | `ON CONFLICT … DO UPDATE` | `ON DUPLICATE KEY UPDATE` + `VALUES(col)` |
| `skipDuplicates` | `ON CONFLICT DO NOTHING` | `INSERT IGNORE` |
| `findOrCreate` | `xmax = 0` | SELECT → INSERT → retry on unique violation |
| `in` / `notIn` | array bind | `JSON_TABLE` |
| `search` | POSIX `~` | `REGEXP` |
| `ilike` | `ILIKE` | `LOWER(col) LIKE LOWER(?)` |
| JSON operators | `@>`, `?`, `#>` | `JSON_CONTAINS` / `JSON_EXTRACT` / `JSON_CONTAINS_PATH` |
| Nested includes | `json_agg … FILTER` | JOIN `JSON_ARRAYAGG` when possible; otherwise batched `IN` queries (no `LATERAL`) |
| `distinct` (`DISTINCT ON`) | supported | throws |
| Partial indexes `index({ where })` | supported | rejected at schema compile |
| PostGIS | supported | rejected |
| `interval` / `inet` / `cidr` / range types | supported | rejected at schema compile |
| `datasource.schema` | multi-schema | ignored (URL database) |

MariaDB has no `LATERAL`, so correlated `JSON_ARRAYAGG` derived tables (the MySQL 8 / Postgres inline has-many subquery) cannot see outer columns such as `` `users`.`id` ``. Those includes are loaded with a follow-up `WHERE fk IN (…)` query instead.

`createManyAndReturn` for serial primary keys uses `LAST_INSERT_ID()` plus row count inside a transaction and assumes consecutive autoincrement values.

Everything else — relations, nested writes, cursor pagination, aggregates, `groupBy`, savepoint-based nested transactions — behaves the same as on PostgreSQL.
