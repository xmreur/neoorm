# Queries

## Find

```ts
// By ID (scalar primary key — pass a string)
const user = await db.users.findById(id);

// By composite primary key — pass an object with all PK columns
const item = await db.items.findById({ tenantId: "t1", itemCode: "c1" });

// First match (null if not found)
const user = await db.users.findFirst({ where: { email: "a@b.com" } });

// All matching
const users = await db.users.findMany({ where: { published: true } });

// Unique constraint lookup
const user = await db.users.findUnique({ where: { slug: "hello" } });
```

## Create

```ts
const user = await db.users.create({ data: { email: "a@b.com" } });

// Bulk insert (returns count)
const count = await db.users.createMany({
  data: [{ email: "a@b.com" }, { email: "b@b.com" }],
});

// Bulk insert with returned rows (serial IDs, UUIDs, defaults materialized)
const users = await db.users.createManyAndReturn({
  data: [{ email: "a@b.com" }, { email: "b@b.com" }],
});
```

## Update

```ts
// Single record
const user = await db.users.update({
  where: { id: userId },
  data: { email: "new@b.com" },
});

// By ID (scalar PK — string; composite PK — object)
const user = await db.users.updateById(id, { data: { name: "New" } });
const item = await db.items.updateById(
  { tenantId: "t1", itemCode: "c1" },
  { data: { name: "Updated" } },
);

// Multiple records
const count = await db.users.updateMany({
  where: { email: { contains: "@old" } },
  data: { status: "archived" },
});
```

## Delete

```ts
await db.users.delete({ where: { id: userId } });

// Scalar PK — pass a string
await db.users.deleteById(userId);

// Composite PK — pass an object
await db.items.deleteById({ tenantId: "t1", itemCode: "c1" });

const count = await db.users.deleteMany({
  where: { email: { contains: "@spam" } },
});
```

## Upsert

```ts
await db.users.upsert({
  where: { email: "a@b.com" },
  create: { email: "a@b.com", name: "A" },
  update: { name: "A" },
});
```

## Find or create

Atomically insert a row or return an existing one when a unique constraint matches. Unlike `upsert`, existing rows are never updated.

`where` must identify a unique constraint (same rules as `findUnique` and `upsert`).

```ts
const { record, created } = await db.tags.findOrCreate({
  where: { slug: "orm" },
  create: { slug: "orm", name: "ORM" },
});
// created: true if a new row was inserted, false if an existing row was returned
```

## Where clauses

### Column filters

Equality shorthand and explicit operators:

```ts
await db.posts.findMany({ where: { published: true } });

await db.posts.findFirst({
  where: {
    title: { contains: "ORM" },
    views: { gte: 100 },
    id: { in: ["post_1", "post_2"] },
  },
});
```

| Type | Operators |
|------|-----------|
| String | `equals`, `contains`, `startsWith`, `endsWith`, `in`, `notIn` |
| Numeric / Date | `equals`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn` |
| JSON | `jsonContains`, `hasKey`, `hasAnyKeys`, `hasAllKeys`, `path` |
| All nullable | `isNull`, `isNotNull` |

### Logical combinators

```ts
await db.users.findMany({
  where: {
    OR: [
      { email: { contains: "@example.com" } },
      { email: { contains: "@test.com" } },
    ],
    NOT: { name: { isNull: true } },
    createdAt: { gte: new Date("2025-01-01") },
  },
});
```

### Relation filters

```ts
// users who have at least one published post
await db.users.findMany({
  where: { posts: { some: { published: true } } },
});

// posts whose author has a verified email
await db.posts.findMany({
  where: { author: { email: { contains: "@" } } },
});

// posts tagged "orm" (many-to-many via junction table)
await db.posts.findMany({
  where: { tags: { some: { slug: "orm" } } },
});
```

| Pattern | Use for |
|---------|---------|
| `authorId: "user_1"` | Filter by FK column value |
| `author: { email: "a@b.c" }` | Filter by related record (to-one) |
| `posts: { some: { ... } }` | At least one related record matches (to-many) |
| `posts: { every: { ... } }` | All related records match (to-many) |
| `posts: { none: { ... } }` | No related records match (to-many) |

Relation filters compile to SQL `EXISTS` subqueries, so they work with `findMany`, `count`, `updateMany`, and `deleteMany` without duplicate rows.

### JSON and decimal filters

```ts
// jsonb — partial / subset match (@> containment)
await db.posts.findMany({
  where: { metadata: { jsonContains: { featured: true } } },
});

// jsonb — key existence and path filters
await db.posts.findMany({
  where: {
    metadata: {
      hasKey: "featured",
      hasAnyKeys: ["category", "tags"],
      path: { segments: ["category"], equals: "engineering" },
    },
  },
});

// decimal — compare as strings
await db.posts.findMany({
  where: { price: { gte: "9.99", lte: "49.99" } },
});
```

### `distinct`

PostgreSQL `DISTINCT ON` — `orderBy` must lead with the same columns:

```ts
await db.users.findMany({
  distinct: ["email"],
  orderBy: { email: "asc" },
});
```

## Selective `with` return types

Relation `select` narrows the TypeScript return type at compile time:

```ts
const users = await db.users.findMany({
  with: { posts: { select: { title: true } } },
});
// users[0].posts[0].title is string; .body is excluded from the type
```

## Cursor pagination

For feeds, infinite scroll, and large tables, use `paginate` instead of `limit`/`offset`. It uses **keyset pagination** on your `orderBy` columns plus the table primary key as a stable tiebreaker.

```ts
let cursor: { createdAt: string; id: string } | null = null;

for (;;) {
  const page = await db.posts.paginate({
    where: { published: true },
    orderBy: { createdAt: "desc" },
    take: 20,
    ...(cursor ? { after: cursor } : {}),
    with: { author: true },
  });

  for (const post of page.items) { /* render */ }

  if (!page.hasMore) break;
  cursor = page.nextCursor;
}
```

- `orderBy` is required; scalar `id` is appended automatically when omitted.
- `take` is the page size; `hasMore` uses a `take + 1` probe row.
- `after` is a typed cursor object (`nextCursor` from the previous page).
- For HTTP APIs, encode cursors with `encodeCursor` / `decodeCursor` from `neoorm`.
- On feed tables, add a composite index on the sort columns.

## Aggregates

### Relation counts in `with`

```ts
const users = await db.users.findMany({
  with: {
    _count: { posts: true },
    profile: true,
  },
});
// users[0]._count.posts === number
```

Optional per-relation filter: `_count: { posts: { where: { published: true } } }`.

### Table-level `aggregate()`

```ts
const stats = await db.posts.aggregate({
  where: { published: true },
  _count: true,
  _avg: { views: true },
});
// { _count: number, _avg: { views: number | null } }
```

For grouped dashboards, use `db.sql` or the `sqlBuilder` helper.

## Count

```ts
const total = await db.users.count({ where: { active: true } });
```
