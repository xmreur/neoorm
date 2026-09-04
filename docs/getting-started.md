# Getting started

## Scaffold a new project

```bash
bunx neoorm init
```

This creates `neoorm.config.ts`, `schema.ts`, and `.env.example`. Run `bunx neoorm migrate dev` after setting your database URL.

```bash
cp .env.example .env
# edit DATABASE_URL in .env
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
import {
  defineSchema,
  fk,
  id,
  table,
  text,
  timestamps,
  uuid,
} from "neoorm/schema";

export const schema = defineSchema({
  users: table({
    id: uuid().primary(),
    email: text().notNull().unique(),
    ...timestamps(),
  }),

  posts: table({
    id: id(),
    authorId: fk("users").notNull().index().inverse("posts"),
    title: text().notNull(),
  }),
});
```

- `table({ ... })` uses the accessor as the SQL table name.
- `fk("users")` references the **users accessor** (not a SQL string).
- Relation names are inferred (`authorId` → `author` on posts, `posts` on users when `.inverse("posts")` is set).

See [Schema DSL](schema.md).

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

## SQLite

Set `provider: "sqlite"` and `url` to a file path or `:memory:`:

```ts
datasource: {
  provider: "sqlite",
  url: "./dev.db",
},
```

```ts
import { createNeoOrmClient } from "neoorm";
import { manifest } from "./neoorm/manifest.js";

const db = createNeoOrmClient(manifest, {
  provider: "sqlite",
  databasePath: "./dev.db",
});
```

See [SQLite](sqlite.md).

## Tenant-specific schemas

```ts
const tenantDb = createNeoOrmClient(manifest, {
  connectionString: process.env.DATABASE_URL!,
  schema: "tenant_acme",
});
```

Raw `db.sql` / `db.execute` are not rewritten — qualify tenant schema yourself in raw SQL.
