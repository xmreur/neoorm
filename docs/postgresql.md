---
title: PostgreSQL
description: PostgreSQL setup, pools, schemas, extensions, JSONB, and ranges.
group: dialects
order: 10
---

# PostgreSQL

PostgreSQL is NeoORM's default dialect. It uses the `pg` driver, `$1, $2` positional parameters, `RETURNING` on all writes, and native support for JSONB, arrays, enums, ranges, full-text search, and extensions.

## Install and configure

```bash
bun add neoorm pg
bun add -d @types/pg
```

```ts
// neoorm.config.ts
import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: {
    provider: "postgresql",
    url: process.env.DATABASE_URL!,
    // schema: "app",       // optional non-public schema
    // enum: "native",      // "check" (default) | "union" | "native"
  },
});
```

## Connecting with a pool

Pass a connection string or an existing `pg.Pool` to the generated client:

```ts
import { Pool } from "pg";
import { createNeoOrmClientFromPool } from "neoorm";
import { manifest } from "./neoorm/manifest.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = createNeoOrmClientFromPool(manifest, pool);
```

## Non-public schemas and multi-tenancy

Set `datasource.schema` (e.g. `"app"`) to place tables, indexes, and native enums in a dedicated PostgreSQL schema. NeoORM creates the schema if missing and schema-qualifies index and enum DDL. Changing `datasource.schema` generates `ALTER TABLE … SET SCHEMA` and moves existing enum types with the tables.

At runtime, `db.sql` and `db.execute` automatically qualify unqualified manifest table names with the configured tenant schema.

## PostgreSQL-specific capabilities

| Feature | How it works in NeoORM |
|---------|------------------------|
| **Arrays** | Native `TEXT[]`, `INTEGER[]`, `UUID[]`, and enum arrays with `has`, `hasEvery`, `hasSome` (`= ANY`, `@>`, `&&`) |
| **JSONB** | Native `JSONB` with `jsonContains` (`@>`), `hasKey` (`?`), `hasAnyKeys`, `hasAllKeys`, and `path` (`#>` / `#>>`) |
| **Ranges** | `int4Range()`, `int8Range()`, `numRange()`, `tsRange()`, `tstzRange()`, `dateRange()` (PostgreSQL-only) |
| **Full-text search** | `tsvector()` + `.generated("to_tsvector(...)")` + GIN index + `searchTs` (`plain`, `phrase`, `websearch`) |
| **Indexes** | `btree`, `gin`, `gist`, `brin`, `hash`, `bloom` (auto-adds `bloom` extension), expression keys, and partial `WHERE` |
| **Native enums** | `datasource.enum: "native"` emits `CREATE TYPE` and `ALTER TYPE … ADD VALUE` |
| **Extensions** | `defineSchema(tables, { extensions: ["uuid-ossp", "pg_trgm"] })`; plugins like [PostGIS](plugins.md) register their extensions automatically |
| **DISTINCT ON** | `findMany({ distinct: ["email"], orderBy: { email: "asc" } })` |
| **Migrations** | Transactional DDL under `pg_advisory_xact_lock`; full rollback on failure |
| **Atomic findOrCreate** | Single-statement `INSERT … ON CONFLICT DO UPDATE` with `(xmax = 0)` |
