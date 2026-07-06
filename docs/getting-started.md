# Getting started

## Scaffold a new project

```bash
npx neoorm init
```

This creates `neoorm.config.ts`, `schema.ts`, `.env.example`, generates `neoorm/client.ts` (and related files), and writes the first migration under `neoorm/migrations/`.

Set your database URL:

```bash
cp .env.example .env
# edit DATABASE_URL in .env
```

Apply migrations:

```bash
npx neoorm migrate deploy
```

Query:

```ts
import { db } from "./neoorm/client.js";

const user = await db.users.findById(userId, {
  with: { posts: { orderBy: { createdAt: "desc" }, limit: 10 } },
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
    authorId: fk("users.id", { as: "author", inverse: "posts", nullable: false }),
    title: text().notNull(),
  }),
});
```

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
npx neoorm generate
```

This writes `client.ts`, `manifest.ts`, `models.ts`, `includes.ts`, and migration SQL when the schema changed.

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
