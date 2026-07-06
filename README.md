# NeoOrm
<p>
  <strong>NeoOrm</strong> is a TypeScript-first SQL ORM built for people who want <strong>type safety without the complexity</strong>.
  Schema → codegen → typed client — you own the SQL, we handle the boilerplate.

  PostgreSQL dialect ships today &mdash; MySQL, SQLite, and others are on the roadmap.
</p>

<p>
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="docs/getting-started.md"><strong>Getting started</strong></a> ·
  <a href="docs/cli.md"><strong>CLI reference</strong></a> ·
  <a href="examples/blog/queries.example.ts"><strong>Example</strong></a>
</p>

```
npm install neoorm pg
```

Requires **Node.js 20+** (PostgreSQL driver ships now; more databases coming).

---

## Why NeoOrm?

**No `any`. No codegen runtime. No lock-in.**

Most ORMs force you to learn their query language, fight their type system, or ship a heavy runtime. NeoOrm takes a different approach: you write a plain TypeScript schema, it generates a typed client, and you write real SQL — amplified by types, not abstracted away.

- **Schema as code** — one source of truth for types and the database
- **Generated client** — zero-cost abstractions, full autocomplete
- **Relations done right** — nested reads, writes, and filters without N+1 footguns
- **PostgreSQL powered** — arrays, JSONB, PostGIS, enums, full-text, extensions — no abstraction layer that gets in the way. MySQL, SQLite, and more are coming.
- **Migrations built-in** — diff your schema, get SQL, deploy. Rollback supported.

---

## Quick start

```bash
npx neoorm init               # scaffold schema, config, client
npx neoorm migrate deploy      # create tables
```

```ts
import { db } from "./neoorm/client.js";

// Create with nested relation write
const user = await db.users.create({
  data: {
    email: "alice@example.com",
    profile: { create: { name: "Alice" } },
  },
});

// Fetch with typed includes, pagination, and filters
const posts = await db.posts.findMany({
  where: { published: true, tags: { some: { slug: "typescript" } } },
  orderBy: { createdAt: "desc" },
  take: 20,
  with: { author: true, _count: { comments: true } },
});
```

---

## Features

<table>
  <tr>
    <td width="50%"><strong>🧩 Schema DSL</strong><br/>Tables, columns, foreign keys, indexes, enums, composite keys, many-to-many — all in TypeScript with full type inference.</td>
    <td width="50%"><strong>📦 Code generation</strong><br/>`neoorm generate` emits a typed client, models with payload types, include types, a manifest, and migration SQL.</td>
  </tr>
  <tr>
    <td><strong>🔍 Rich queries</strong><br/>`findMany`, `findById`, `findUnique`, `count`, `aggregate`. Where operators for strings, numbers, dates, JSONB, arrays, and nulls. `AND/OR/NOT` combinators.</td>
    <td><strong>📄 Cursor pagination</strong><br/>Keyset-based `paginate` for feeds and infinite scroll. Type-safe cursors, `hasMore` probe, and `encodeCursor`/`decodeCursor` for HTTP APIs.</td>
  </tr>
  <tr>
    <td><strong>🔗 Relation writes</strong><br/>Nested `connect`, `create`, `disconnect`, `set`, `delete` on to-one, one-to-many, and many-to-many — all in a single query.</td>
    <td><strong>🔁 Transactions</strong><br/>Interactive callbacks, batch steps, savepoints for nested transactions, isolation levels, read-only mode.</td>
  </tr>
  <tr>
    <td><strong>🧱 Migrations</strong><br/>Schema diff generates DDL automatically. `deploy`, `dev`, `status`, `reset`, and `down` (rollback). Destructive change detection with `--accept-data-loss` opt-in.</td>
    <td><strong>🔌 Plugin system</strong><br/>Column type plugins for PostGIS (geometry, geography, spatial operators), citext, and custom extensions.</td>
  </tr>
  <tr>
    <td><strong>🐘 PostgreSQL powered</strong><br/>JSONB, arrays (`TEXT[]`, `INTEGER[]`), `NUMERIC`, `BYTEA`, native enums, UUID v4/v7, serial identity, `CITEXT`, extensions. More databases on the roadmap.</td>
    <td><strong>🎯 TypeScript end-to-end</strong><br/>Strict types from schema to query results. Discriminated payload types for `with` includes. Compile-time union checking on enums.</td>
  </tr>
</table>

---

## Documentation

| Topic | |
|-------|-|
| [Getting started](docs/getting-started.md) | Setup, manual config, env vars, tenant schemas |
| [Schema DSL](docs/schema.md) | Tables, columns, types, enums, indexes, many-to-many, naming strategy |
| [Queries](docs/queries.md) | CRUD, where clauses, pagination, aggregates, distinct |
| [Relation writes](docs/relations.md) | Nested connect/create/disconnect/set/delete |
| [Transactions](docs/transactions.md) | Interactive, batch, nested, isolation levels |
| [Migrations](docs/migrations.md) | Deploy, dev, status, rollback, reset |
| [CLI reference](docs/cli.md) | All commands and flags |
| [Configuration](docs/configuration.md) | Config file options reference |
| [Plugins](docs/plugins.md) | PostGIS, citext, custom plugins |

See the [blog example](examples/blog/schema.ts) for a complete schema, and [queries.example.ts](examples/blog/queries.example.ts) for typed queries and mutations.

---

## API surface

| Import | Purpose |
|--------|---------|
| `neoorm` | `defineConfig`, `createNeoOrmClient`, `createNeoOrmClientFromPool`, client types |
| `neoorm/schema` | Schema DSL (`defineSchema`, `table`, column builders, `fk`, `manyToMany`, `index`, `unique`, `primaryKey`) |
| `neoorm/sql` | Tagged SQL templates (`sql`), SQL fragment builder, fluent query builder |
| `neoorm/plugins` | Plugin registry, `NeoOrmPlugin`, `ColumnTypePlugin` |
| `neoorm/plugins/postgis` | PostGIS column types (`geometry`, `geography`, `point`) and spatial operators |

---

## Philosophy

NeoOrm was built because existing TypeScript ORMs either sacrificed type safety for flexibility, or sacrificed flexibility for type safety. We think you shouldn't have to choose.

- **Schema is the source of truth** — not decorators, not reflection, not a proprietary DSL. Your schema file is plain TypeScript.
- **Generated code is a compile-time artifact** — no runtime dependency on the schema. Swap the schema, regenerate, everything still compiles.
- **SQL is not hidden** — the client compiles to parameterized SQL that you can inspect. No magic, no surprises.
- **PostgreSQL first** — we ship with a Postgres dialect and lean into its features. MySQL, SQLite, and other dialects are on the roadmap and will slot into the same architecture.

---

## License

MIT
