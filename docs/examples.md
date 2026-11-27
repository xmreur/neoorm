---
title: Cookbook
description: End-to-end recipes for auth, feeds, soft deletes, search, and PostGIS.
group: guides
order: 10
---

# Cookbook

Focused, copy-paste recipes for common application patterns. For a complete runnable schema and query suite, see [`examples/blog/`](https://github.com/xmreur/neoorm/tree/main/examples/blog) and [`examples/postgis/`](https://github.com/xmreur/neoorm/tree/main/examples/postgis).

## Auth login with `.hidden()` and `.strip()`

Keep password hashes out of default queries, opt in during login, and strip sensitive fields before returning JSON:

```ts
// schema.ts
users: table({
  id: uuid().primary(),
  email: text().notNull().unique(),
  password: text().notNull().hidden(),
  refreshToken: text(),
  ...timestamps(),
}),
```

```ts
const user = await db.users.findFirst({
  where: { email: input.email },
  includeHidden: true,
});

if (!user || !verifyPassword(input.password, user.password)) {
  throw new Error("Invalid credentials");
}

return user.strip({ refreshToken: true }); // plain object without password or refreshToken
```

See [Eager loading & projection](loading.md#sensitive-columns-hidden-and-api-responses-strip).

## Soft-delete unique emails with partial indexes

Allow re-registering an email after an account is soft-deleted, while keeping `findUnique` and `upsert` working on active accounts:

```ts
users: table(
  {
    id: uuid().primary(),
    email: text().notNull(),
    deleted: bool().notNull().default(false),
  },
  (t) => [t.unique(t.email).where({ deleted: false })],
),
```

```ts
// Automatically applies `AND "deleted" = false`
const active = await db.users.findUnique({ where: { email: "ada@example.com" } });
```

See [Partial indexes](schema.md#partial-indexes).

## Cursor-paginated feed with nested authors

Use keyset pagination for infinite scroll and feeds, encoding cursors for HTTP query params:

```ts
import { decodeCursor, encodeCursor } from "neoorm";

const after = query.cursor ? decodeCursor(query.cursor) : undefined;

const page = await db.posts.paginate({
  where: { published: true },
  orderBy: { createdAt: "desc" },
  take: 20,
  ...(after ? { after } : {}),
  omit: { body: true },
  with: {
    author: { select: { id: true, name: true } },
    _count: { comments: true },
  },
});

return {
  items: page.items,
  nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
  hasMore: page.hasMore,
};
```

See [Cursor pagination](filters.md#cursor-pagination).

## Create a post with tags in one call

Connect an existing author and upsert tags via `connectOrCreate` inside a single call:

```ts
const post = await db.posts.create({
  data: {
    title: "Typed SQL without the ceremony",
    body: "…",
    published: true,
    author: { connect: { id: authorId } },
    tags: {
      connectOrCreate: [
        { where: { slug: "orm" }, create: { slug: "orm", name: "ORM" } },
        { where: { slug: "sql" }, create: { slug: "sql", name: "SQL" } },
      ],
    },
  },
  with: { author: true, tags: true },
});
```

See [Nested writes](relations.md).

## Transactional checkout with savepoints

Wrap multi-table writes in `$transaction`, using a nested savepoint when an optional step should not abort the outer work:

```ts
await db.$transaction(async (tx) => {
  const order = await tx.orders.create({
    data: { userId, totalCents: 4900 },
    returnCreated: true,
  });

  await tx
    .$transaction(async (sp) => {
      await sp.auditEvents.create({
        data: { kind: "order.created", refId: order.id },
      });
    })
    .catch(() => undefined); // roll back savepoint only
});
```

See [Transactions](transactions.md).

## Full-text search on PostgreSQL

Store a generated `tsvector` column, index it with GIN, and query it with `searchTs`:

```ts
docs: table(
  {
    id: id(),
    title: text().notNull(),
    searchDoc: tsvector().notNull().generated("to_tsvector('english', title)"),
  },
  (t) => [index(t.searchDoc).using("gin")],
),
```

```ts
const hits = await db.docs.findMany({
  where: {
    searchDoc: { searchTs: { query: "typed sql", parser: "websearch" } },
  },
});
```

See [Full-text search](schema.md#full-text-search) and [Filters & aggregates](filters.md#column-filters).

## Nearby places with PostGIS

```ts
import "neoorm/plugins/postgis";
import { geometry } from "neoorm/plugins/postgis";

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

## Slow-query logging

```ts
const db = createNeoOrmClient(manifest, {
  afterQuery: ({ sql, durationMs }) => {
    if (durationMs > 50) {
      console.warn(`slow ${durationMs.toFixed(1)}ms`, sql);
    }
  },
});
```

See [Raw SQL & logging](raw-sql.md#logging-sql).
