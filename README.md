# NeoOrm

TypeScript-first PostgreSQL ORM with a schema DSL, compile-time types, codegen, and a typed query client.

## Install

```bash
npm install neoorm pg
```

Peer dependency: Node.js 20+ and a PostgreSQL database.

## Quick start

**1. Define a schema** (`schema.ts`):

```ts
import { defineSchema, table, id, text, timestamp, fk } from "neoorm/schema";

export const schema = defineSchema({
  users: table("users", {
    id: id.primary(),
    email: text().notNull().unique(),
    createdAt: timestamp().notNull().defaultNow(),
  }),

  posts: table("posts", {
    id: id.primary(),
    authorId: fk("users.id", { as: "author", inverse: "posts", nullable: false }),
    title: text().notNull(),
  }),
});
```

**2. Configure NeoOrm** (`neoorm.config.ts`):

```ts
import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: {
    provider: "postgresql",
    url: process.env.DATABASE_URL!,
  },
});
```

**3. Generate the client**

```bash
npx neoorm generate
```

**4. Query**

```ts
import { db } from "./neoorm/client.js";

const user = await db.users.findById("user_1", {
  with: {
    posts: { orderBy: { createdAt: "desc" }, limit: 10 },
  },
});
```

## CLI

| Command | Description |
|---------|-------------|
| `neoorm generate` | Emit manifest, typed client, includes, and migrations |
| `neoorm migrate dev` | Apply pending migrations and create a new one if the schema changed |
| `neoorm migrate deploy` | Apply pending migrations |
| `neoorm db push` | Push schema to the database |
| `neoorm db pull` | Introspect the database into a schema file |

## API surface

- `neoorm` — config helpers and `createNeoOrmClient`
- `neoorm/schema` — schema DSL (`table`, `fk`, `manyToMany`, …)
- `neoorm/sql` — tagged SQL templates and query builder

## License

MIT
