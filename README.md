# NeoOrm

TypeScript-first PostgreSQL ORM with a schema DSL, compile-time types, codegen, and a typed query client.

## Install

```bash
npm install neoorm pg
```

Requires Node.js 20+ and PostgreSQL.

## Quick start

**1. Define a schema** (`schema.ts`):

```ts
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

This writes `client.ts`, `manifest.ts`, `models.ts`, `includes.ts`, and migration SQL when the schema changed.

**4. Query**

```ts
import { db } from "./neoorm/client.js";

const user = await db.users.findById(userId, {
  with: {
    posts: { orderBy: { createdAt: "desc" }, limit: 10 },
  },
});
```

## Schema DSL

### Tables and accessors

`defineSchema` keys are TypeScript accessors (`users`, `posts`). The first argument to `table()` is the SQL table name:

```ts
users: table("user", { ... }) // db.users → SQL table "user"
```

Column field names use camelCase in TypeScript. By default, SQL column names are snake_case (`createdAt` → `created_at`).

### Column types

| Builder | SQL type | Notes |
|---------|----------|-------|
| `id.primary()` | `TEXT` | App-generated string IDs (e.g. `user_a1b2c3d4`) |
| `uuid()` | `UUID` | Defaults to UUID v7; pass `{ version: 4 }` for v4 |
| `uuid().primary()` | `UUID` | Primary key; auto-generated on create if omitted |
| `text()` | `TEXT` | |
| `bool()` | `BOOLEAN` | |
| `int()` | `INTEGER` | |
| `timestamp()` | `TIMESTAMPTZ` | Use `.defaultNow()` for `DEFAULT NOW()` |

All column builders support `.notNull()`, `.unique()`, `.default(value)`, `.defaultNow()`, `.primary()`, and `.map(name)`.

Foreign keys use `fk("target_table.target_column", { as, inverse, nullable?, onDelete? })`.

### UUID columns

```ts
import { uuid, table } from "neoorm/schema";

posts: table("posts", {
  id: uuid().primary(),              // UUID v7 (default)
  legacyId: uuid({ version: 4 }),     // UUID v4
})
```

When you call `create` without an `id`, NeoOrm generates a UUID using the configured version.

### Custom SQL column names (`.map()`)

Use `.map()` when the database column name differs from the default snake_case conversion:

```ts
emailAddress: text().notNull().map("email"),
authorId: fk("users.id", { as: "author", inverse: "posts" }).map("author_ref"),
```

`.map()` only produces a migration when the SQL name actually changes. Mapping to the default snake_case name (e.g. `.map("email_verified")` on `emailVerified`) is a no-op — `neoorm generate` warns about this.

### Indexes and composite keys

```ts
posts: table(
  "posts",
  { /* columns */ },
  (t) => ({
    authorIdx: index().on(t.authorId),
    slugUnique: unique(t.slug),
    pk: primaryKey(t.orgId, t.localId),
  }),
)
```

### Many-to-many

Define the junction table, then register the relation after `defineSchema`:

```ts
export const schema = defineSchema({
  posts: table("posts", { /* ... */ }),
  tags: table("tags", { /* ... */ }),
  postTags: table("post_tags", {
    postId: fk("posts.id", { as: "post", inverse: "postTags", nullable: false }),
    tagId: fk("tags.id", { as: "tag", inverse: "postTags", nullable: false }),
  }, (t) => ({
    pk: primaryKey(t.postId, t.tagId),
  })),
});

manyToMany(schema.posts, schema.tags, {
  through: schema.postTags,
  left: "post",
  right: "tag",
  as: "tags",
  inverse: "posts",
});
```

## Transactions

```ts
// Interactive callback
await db.$transaction(async (tx) => {
  const user = await tx.users.create({ data: { email: "a@b.com" } });
  await tx.posts.create({
    data: {
      title: "Hello",
      authorId: user.id,
    },
  });
});

// Batch steps (sequential, one transaction)
const [user, post] = await db.$transaction([
  (tx) => tx.users.create({ data: { email: "a@b.com" } }),
  (tx) => tx.posts.create({ data: { title: "Hello" } }),
]);

// Options
await db.$transaction(fn, {
  isolationLevel: "Serializable", // ReadUncommitted | ReadCommitted | RepeatableRead | Serializable
  readOnly: true,
});
```

Nested `create` calls inside a transaction do not start a separate transaction.

## CLI

| Command | Description |
|---------|-------------|
| `neoorm generate` | Emit manifest, typed client, models, includes, and migrations |
| `neoorm migrate dev` | Apply pending migrations, then generate a new one if the schema changed |
| `neoorm migrate deploy` | Apply pending migrations |
| `neoorm db push` | Push the current snapshot schema to the database |
| `neoorm db pull` | Introspect the database into a schema file |

`generate` always rewrites generated TypeScript files. Migration SQL is created only when the schema diff produces changes (new tables/columns, column renames via `.map()`).

## Plugins

### PostGIS

```ts
import "neoorm/plugins/postgis";
import { geometry, point } from "neoorm/plugins/postgis";

places: table("places", {
  id: uuid().primary(),
  location: geometry({ subtype: "Point", srid: 4326 }).notNull(),
  boundary: point({ srid: 4326 }),
})
```

Spatial `where` operators: `intersects`, `within`, `dWithin`.

```ts
await db.places.findMany({
  where: {
    location: {
      dWithin: {
        geometry: { type: "Point", coordinates: [-122.4, 37.8] },
        distance: 1000,
      },
    },
  },
});
```

PostGIS columns are stored as geometry/geography in PostgreSQL and exposed as GeoJSON in TypeScript.

## API surface

| Import | Purpose |
|--------|---------|
| `neoorm` | Config helpers, `createNeoOrmClient`, client types |
| `neoorm/schema` | Schema DSL (`defineSchema`, `table`, column builders, `fk`, `manyToMany`) |
| `neoorm/sql` | Tagged SQL templates and query builder |
| `neoorm/plugins` | Plugin registry |
| `neoorm/plugins/postgis` | PostGIS column types and spatial operators |

## License

MIT
