# Getting started

## Scaffold a new project

```bash
bunx neoorm init
```

This creates `neoorm.config.ts`, `schema.ts`, and `.env.example` — no client or migrations yet. Run `bunx neoorm migrate dev` after setting your database URL to generate the client and first migration.

Set your database URL:

```bash
cp .env.example .env
# edit DATABASE_URL in .env
```

Generate the typed client and first migration, then apply it:

```bash
bunx neoorm migrate dev
```

Query:

```ts
import { db } from "./neoorm/client.js";

const user = await db.users.findById(userId, {
  with: { posts: { where: { published: true }, orderBy: { createdAt: "desc" }, take: 10 } },
});
```

## Manual setup

### 1. Define a schema

```ts
// schema.ts
import { defineSchema, table, uuid, text, timestamp, fk } from "neoorm/schema";

export const schema = defineSchema({
  users: table("users", {
    id: uuid().primary(),
    email: text().notNull().unique(),
    createdAt: timestamp().notNull().defaultNow(),
  }),

  posts: table("posts", {
    id: uuid().primary(),
    authorId: fk("users.id").notNull().index(),
    title: text().notNull(),
  }),
});
```

`fk()` takes a `"table.column"` string target, so tables can be declared inline. The relation name (`as`) is inferred from the column name (`authorId` → `author`); the inverse on the target table is the plural (`authors`). See [Schema DSL](schema.md#foreign-keys).

### 2. Configure NeoOrm

```ts
// neoorm.config.ts
import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: {
    provider: "postgresql",
    url: process.env.DATABASE_URL!,
    schema: "public",
    enum: "check",
  },
});
```

### 3. Generate the client

```bash
bunx neoorm generate
```

This writes `client.ts`, `manifest.ts`, `models.ts`, `includes.ts`, and migration SQL when the schema changed.

## SQLite

SQLite works with the same schema and commands — no database server or driver install needed. Set the provider to `sqlite` and point `url` at a file or `:memory:`:

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

At runtime, pass the database path (or your own `db` handle) to the client:

```ts
import { createNeoOrmClient } from "neoorm";
import { manifest } from "./neoorm/manifest.js";

const db = createNeoOrmClient(manifest, {
  provider: "sqlite",
  databasePath: "./dev.db",
});
```

Requires Node.js 22.5+ or Bun (or pass your own `db` instance). See [SQLite](sqlite.md) for drivers, type mapping, and limitations.

## Tenant-specific schemas

For tenant-per-schema isolation at runtime, create a client with the tenant schema:

```ts
import { createNeoOrmClient } from "neoorm";
import { manifest } from "./neoorm/manifest.js";

const tenantDb = createNeoOrmClient(manifest, {
  connectionString: process.env.DATABASE_URL!,
  schema: "tenant_acme",
});
```

NeoOrm qualifies generated ORM table references as `"tenant_acme"."users"`. Raw `db.sql` and `db.execute` calls are not rewritten, so qualify raw SQL yourself. Treat schema names as trusted tenant metadata, not raw request input.
