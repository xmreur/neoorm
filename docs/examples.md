# Examples

Copy-paste patterns for common NeoOrm tasks. The full runnable blog demo lives in [`examples/blog/`](https://github.com/xmreur/neoorm/tree/main/examples/blog) (`schema.ts` + `queries.example.ts`). PostGIS sample: [`examples/postgis/`](https://github.com/xmreur/neoorm/tree/main/examples/postgis).

Run `neoorm docs` to browse all documentation locally.

## Blog schema

A small CMS-style schema used throughout these examples:

```ts
import {
  bool,
  defineSchema,
  enumType,
  fk,
  id,
  int,
  jsonb,
  manyToMany,
  table,
  text,
  timestamps,
  uuid,
} from "neoorm/schema";

export const schema = defineSchema({
  users: table({
    id: uuid().primary(),
    email: text().notNull().unique(),
    name: text(),
    password: text().notNull().hidden(),
    ...timestamps(),
  }),

  profiles: table({
    id: id(),
    userId: fk("users").notNull().unique().onDelete("cascade").inverse("profile"),
    bio: text(),
  }),

  posts: table({
    id: id(),
    authorId: fk("users").notNull().index().onDelete("restrict").inverse("posts"),
    title: text().notNull(),
    body: text().notNull(),
    published: bool().notNull().default(false),
    views: int().notNull().default(0),
    status: enumType(["draft", "published", "archived"]).notNull().default("draft"),
    metadata: jsonb<Record<string, unknown>>(),
    ...timestamps(),
    tags: manyToMany("tags"),
  }),

  comments: table({
    id: id(),
    postId: fk("posts").notNull().onDelete("cascade").inverse("comments"),
    authorId: fk("users").notNull(),
    body: text().notNull(),
    createdAt: timestamps().createdAt,
  }),

  tags: table({
    id: id(),
    slug: text().notNull().unique(),
    name: text().notNull(),
  }),
});
```

Generate the client, then import it:

```ts
import { db } from "./neoorm/client.js";
```

## CRUD basics

```ts
// Create
const user = await db.users.create({
  data: { email: "alice@example.com", name: "Alice" },
});

// Create and return full row
const post = await db.posts.create({
  data: {
    title: "Hello",
    body: "World",
    authorId: user.id,
  },
  returnCreated: true,
});

// Find by primary key
const found = await db.users.findById(user.id);

// Find first match
const draft = await db.posts.findFirst({
  where: { published: false },
  orderBy: { createdAt: "desc" },
});

// Update
await db.users.updateById(user.id, {
  data: { name: "Alice Smith" },
});

// Update many
await db.posts.updateMany({
  where: { published: false },
  data: { views: 0 },
});

// Delete
await db.posts.delete({ where: { id: post.id } });
await db.users.deleteById(user.id);
```

## Nested reads (`with`)

```ts
const user = await db.users.findById("user_1", {
  with: {
    profile: true,
    posts: {
      where: { published: true },
      orderBy: { createdAt: "desc" },
      take: 10,
      with: {
        comments: {
          orderBy: { createdAt: "desc" },
          take: 5,
          with: { author: { select: { id: true, name: true } } },
        },
        tags: true,
      },
    },
  },
});
```

Select only specific columns:

```ts
const users = await db.users.findMany({
  select: { id: true, email: true },
  with: {
    posts: { select: { title: true, published: true } },
  },
});
```

Omit columns at query time (still fetched from DB):

```ts
const user = await db.users.findById("user_1", {
  omit: { createdAt: true, updatedAt: true },
});
```

## Where filters

```ts
// Equality and operators
const posts = await db.posts.findMany({
  where: {
    published: true,
    views: { gte: 100 },
    title: { contains: "ORM" },
  },
});

// Case-insensitive search
const hits = await db.posts.findMany({
  where: { title: { contains: "orm", mode: "insensitive" } },
});

// Logical combinators
const filtered = await db.posts.findMany({
  where: {
    OR: [
      { status: "published" },
      { AND: [{ published: true }, { views: { gt: 50 } }] },
    ],
  },
});

// Filter through relations
const authors = await db.users.findMany({
  where: {
    posts: { some: { published: true, tags: { some: { slug: "typescript" } } } },
  },
});

// JSONB containment
const featured = await db.posts.findMany({
  where: {
    metadata: {
      jsonContains: { featured: true, category: "engineering" },
    },
  },
});

// Exists / count helpers
const taken = await db.users.exists({ where: { email: "alice@example.com" } });
const total = await db.posts.count({ where: { published: true } });
```

## Relation writes

Create with nested relations in one call:

```ts
const post = await db.posts.create({
  data: {
    title: "NeoORM",
    body: "Typed relations and JSONB.",
    published: true,
    status: "published",
    author: { connect: { id: "user_1" } },
    tags: {
      connectOrCreate: [
        {
          where: { slug: "orm" },
          create: { slug: "orm", name: "ORM" },
        },
      ],
    },
  },
  with: { author: true, tags: true },
});
```

Update relations on an existing row:

```ts
await db.posts.update({
  where: { id: post.id },
  data: {
    views: { increment: 1 },
    comments: {
      create: [
        {
          body: "Great post!",
          author: { connect: { id: "user_1" } },
        },
      ],
    },
    tags: { set: [{ id: "tag_1" }, { id: "tag_2" }] },
  },
});
```

`connect`, `disconnect`, `set`, `create`, and `delete` work on to-one, one-to-many, and many-to-many relations. See [Relation writes](relations.md).

## Pagination

Offset/limit:

```ts
const page = await db.posts.findMany({
  where: { published: true },
  orderBy: { createdAt: "desc" },
  take: 20,
  skip: 40,
});
```

Keyset (cursor) pagination for feeds:

```ts
let cursor: { createdAt: Date; id: string } | null = null;

const page = await db.posts.paginate({
  where: { published: true },
  orderBy: { createdAt: "desc" },
  take: 20,
  ...(cursor ? { after: cursor } : {}),
});

cursor = page.nextCursor;
// page.items, page.hasMore, page.hasPrevious
```

## Aggregations

```ts
const byStatus = await db.posts.groupBy({
  by: ["status"],
  _count: true,
  orderBy: { _count: "desc" },
});

const stats = await db.posts.aggregate({
  _count: true,
  _avg: { views: true },
  where: { published: true },
});
```

## Transactions

Batch steps (single transaction):

```ts
const [author, post] = await db.$transaction([
  (tx) =>
    tx.users.create({
      data: { email: "author@example.com", name: "Author" },
    }),
  (tx) =>
    tx.posts.create({
      data: {
        title: "Transactional post",
        body: "...",
        author: { connect: { id: "user_1" } },
      },
    }),
]);
```

Interactive callback with rollback:

```ts
await db.$transaction(async (tx) => {
  const user = await tx.users.create({
    data: { email: "x@y.z", name: "Temp" },
  });
  await tx.posts.create({
    data: {
      title: "Draft",
      body: "...",
      author: { connect: { id: user.id } },
    },
  });
  // throw to roll back everything
});
```

Nested savepoints:

```ts
await db.$transaction(async (tx) => {
  await tx.users.create({ data: { email: "outer@x.y", name: "Outer" } });

  await tx.$transaction(async (nested) => {
    await nested.users.create({ data: { email: "inner@x.y", name: "Inner" } });
    throw new Error("roll back inner only");
  }).catch(() => undefined);
});
```

## Raw SQL

Use `db.sql` when you need full SQL control. Table names in tagged templates use your schema accessors:

```ts
const rows = await db.sql`
  SELECT u.id, u.email, count(p.id) AS post_count
  FROM users u
  LEFT JOIN posts p ON p.author_id = u.id
  GROUP BY u.id, u.email
  ORDER BY post_count DESC
`;
```

## API responses (`strip`)

Fetch sensitive fields for auth, then strip before sending JSON:

```ts
const user = await db.users.findFirst({
  where: { email: input.email },
});

if (!user || !verifyPassword(input.password, user.password)) {
  throw new Error("Invalid credentials");
}

return user.strip(); // removes .hidden() columns (e.g. password)
return user.strip({ email: true }); // hidden + extra fields
```

`.strip()` is non-enumerable and returns a plain object. See [Queries → API responses](queries.md#api-responses-strip).

## Explicit junction table (many-to-many)

Auto-junction works for most cases. For a custom junction table:

```ts
posts: table({
  id: id(),
  tags: manyToMany("tags", {
    through: "postTags",
    leftKey: "postId",
    rightKey: "tagId",
  }),
}),
postTags: table("post_tags", {
  postId: fk("posts").primary(),
  tagId: fk("tags").primary(),
}),
```

`through` is the **accessor** (`postTags`), not the SQL name (`post_tags`).

## SQLite

Same schema and client API — point config at a file:

```ts
// neoorm.config.ts
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

See [SQLite](sqlite.md) for type mapping and limitations.

## PostGIS

```ts
import "neoorm/plugins/postgis";
import { geometry, point } from "neoorm/plugins/postgis";

places: table({
  id: id(),
  name: text().notNull(),
  location: geometry({ subtype: "Point", srid: 4326 }).notNull(),
}),
```

```ts
const nearby = await db.places.findMany({
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

See [Plugins](plugins.md).

## Schema extras

Composite unique constraint and partial index:

```ts
import { fk, id, index, table, text, unique } from "neoorm/schema";

posts: table(
  {
    id: id(),
    authorId: fk("users").notNull(),
    title: text().notNull(),
    published: bool().notNull().default(false),
  },
  (t) => [
    unique(t.authorId, t.title),
    index(t.title).where({ published: true }),
  ],
),
```

SQL name override when accessor differs from table name:

```ts
postTags: table("post_tags", {
  postId: fk("posts").primary(),
  tagId: fk("tags").primary(),
}),
```

## Next steps

| Topic | Doc |
|-------|-----|
| Schema DSL | [schema.md](schema.md) |
| Queries | [queries.md](queries.md) |
| Relation writes | [relations.md](relations.md) |
| Migrations | [migrations.md](migrations.md) |
| CLI | [cli.md](cli.md) |
