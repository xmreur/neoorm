---
title: Filters & aggregates
description: Where operators, relation filters, pagination, count, and aggregates.
group: queries
order: 20
---

# Filters & aggregates

Filter rows with typed column and relation operators, paginate feeds with offset or keyset cursors, and compute `count`, `exists`, `aggregate`, and `groupBy` summaries.

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

Unknown column names and operators fail at compile time (`unknown_column`, with “did you mean” hints). JSON columns may still use a plain object as equality (`{ metadata: { featured: true } }`).

Operator bags are named filter interfaces (`StringFilter`, `ComparableFilter`, `JsonFilter` — also exported from `neoorm/schema`), so a wrong operator points at the filter instead of dumping the whole input type:

```ts
// error TS2353: 'contains' does not exist in type 'ComparableFilter<string>'.
await db.posts.findMany({ where: { price: { contains: "9" } } });
```

| Type | Operators |
|------|-----------|
| String | `equals`, `contains`, `startsWith`, `endsWith`, `search`, `searchTs`, `in`, `notIn`, `mode` |
| Numeric / Date | `equals`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn` |
| JSON | `jsonContains`, `hasKey`, `hasAnyKeys`, `hasAllKeys`, `path` |
| Array (`textArray`, `intArray`, `uuidArray`, `enumArray`) | `equals`, `has`, `hasEvery`, `hasSome` |
| PostGIS (`geometry`, `geography`, `point`) | `intersects`, `within`, `dWithin` |
| All nullable | `isNull`, `isNotNull` |

`contains`, `startsWith`, `endsWith`, and `equals` compile to `LIKE` / `=`. Pass sibling `mode: "insensitive"` for case-folding (`ILIKE` on Postgres, `LOWER(col) LIKE LOWER($n)` on SQLite/MySQL/MariaDB). SQLite `LIKE` is ASCII case-insensitive even in default mode. `%` and `_` in the search string are matched literally (`ESCAPE '\'` on Postgres/SQLite, `ESCAPE '\\'` on MySQL/MariaDB).

`search` is POSIX regex on PostgreSQL (`~`, or `~*` with `mode: "insensitive"`), `REGEXP_LIKE` on MySQL 8, `REGEXP` on MariaDB, and JavaScript `RegExp` (`REGEXP` / `regexp_i`) on SQLite.

`searchTs` is full-text search: `to_tsvector(...) @@ plainto_tsquery(...)` on PostgreSQL, `MATCH ... AGAINST (... IN NATURAL LANGUAGE MODE)` on MySQL/MariaDB, and unsupported on SQLite (it fails at query-build time — SQLite FTS5 needs virtual tables). It is only valid on `text`, `citext`, and `tsvector()` (no `to_tsvector` wrapper). `uuid`, `date`, `enum`, and `money` do not accept it. On MySQL and MariaDB, `MATCH ... AGAINST` needs `index(...).using("fulltext")`.

```ts
await db.posts.findMany({
  where: { title: { searchTs: "orm tutorial" } },
});

await db.posts.findMany({
  where: {
    title: {
      searchTs: { query: "orm tutorial", language: "german", parser: "phrase" },
    },
  },
});
```

`parser` is `plain` (`plainto_tsquery`, the default), `phrase` (`phraseto_tsquery`), or `websearch` (`websearch_to_tsquery`). `language` defaults to `english` and must match `/^[a-z_]+$/` since it is interpolated as the `regconfig`. On MySQL/MariaDB the `language` and `parser` options are accepted but ignored.

JSON operators on PostgreSQL use `@>`, `?`, and `#>` / `#>>`. On SQLite they compile to `json_patch` (object containment), `json_each` (key existence), and `json_extract` (path). On MySQL and MariaDB they compile to `JSON_CONTAINS`, `JSON_CONTAINS_PATH`, and `JSON_EXTRACT`.

Array columns use `has` for one element, `hasEvery` when every value must be present, and `hasSome` when any value is enough. On PostgreSQL those are `$n = ANY(col)`, `col @> $n`, and `col && $n`. On SQLite they use `json_each`. On MySQL and MariaDB they use `JSON_CONTAINS` and `JSON_OVERLAPS`. Arrays are stored as JSON outside PostgreSQL.

```ts
await db.posts.findMany({
  where: { title: { contains: "orm", mode: "insensitive" } },
});

await db.users.findMany({
  where: { email: { equals: "Ada@Example.com", mode: "insensitive" } },
});

await db.posts.findMany({
  where: { title: { search: "^Neo", mode: "insensitive" } },
});
```

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

Empty `OR: []` matches no rows. Empty `AND: []` matches every row. Empty `in: []` is false; `{ OR: [{ id: { in: [] } }, { name: "Ada" }] }` still matches the other branch.

### Relation filters

```ts
// users who have at least one published post
await db.users.findMany({
  where: { posts: { some: { published: true } } },
});

// users with at least five published posts
await db.users.findMany({
  where: { posts: { _count: { gte: 5, where: { published: true } } } },
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
| `posts: { every: { ... } }` | All related records match (to-many). Compiled as `NOT EXISTS` of related rows that fail the nested filter. |
| `posts: { none: { ... } }` | No related records match (to-many) |
| `posts: { _count: { gte: 5, where: { ... } } }` | Related-row count matches. `where` is optional. `equals`, `gt`, `gte`, `lt`, and `lte` can be combined. |

`some`, `every`, and `none` compile to SQL `EXISTS` subqueries. `_count` compiles to a scalar `COUNT` subquery. Both work with `findMany`, `count`, `updateMany`, and `deleteMany` without duplicate rows.

### JSON and decimal filters

```ts
// jsonb — partial / subset match (`@>` on PostgreSQL, `json_patch` on SQLite)
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

PostgreSQL `DISTINCT ON` — `orderBy` must lead with the same columns (key order is the ORDER BY prefix):

```ts
await db.users.findMany({
  distinct: ["email"],
  orderBy: { email: "asc" },
});
```

Not supported on MySQL or MariaDB (`DISTINCT ON` is PostgreSQL-only; SQLite emulates it with `ROW_NUMBER()`). Use `groupBy({ by: [...] })` or a raw `db.sql` query instead.

## Offset pagination

Page numbers, admin tables, and **Paginated Read** benchmarks should use `findMany({ take, skip, orderBy })`. That path is `LIMIT`/`OFFSET` on the same cached SELECT as find-all (no extra row, no cursor encoding).

```ts
const page = await db.posts.findMany({
  orderBy: { id: "asc" },
  take: 20,
  skip: 40,
});
```

Do not use `paginate` for that comparison: `paginate` is keyset pagination (`take + 1`, cursors, `hasMore`).

Nullable `orderBy` columns on `findMany` and `findFirst` use the same placement as `paginate`: `asc` is `NULLS LAST` and `desc` is `NULLS FIRST`. MySQL and MariaDB write that as `(col IS NULL)` before the column, because they reject a `NULLS` clause.

## Cursor pagination

For feeds, infinite scroll, and large tables, use `paginate` instead of `take`/`skip`. It uses **keyset pagination** on your `orderBy` columns plus the table primary key as a stable tiebreaker.

```ts
let cursor: { createdAt: Date; id: string } | null = null;

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

- `orderBy` is required; scalar `id` is appended automatically when omitted. Columns may use different directions. Nullable sort columns use the same placement as `findMany` and `findFirst`: `asc` is `NULLS LAST`, `desc` is `NULLS FIRST`.
- `select`, `omit`, and `includeHidden` work like `findMany`. Cursor fields used by `orderBy` stay in the SQL (and in `nextCursor` / `prevCursor`) even when omitted from `items`.
- `take` is the page size; `hasMore` / `hasPrevious` use a `take + 1` probe in the query direction. A `before` page also probes once forward so `hasMore` is not assumed true. After an `after` page, `hasPrevious` is true because `after` was passed.
- `after` is a typed cursor (`nextCursor` from the previous page). `before` walks the other way (`prevCursor`).
- `after` and `before` can be combined as exclusive window bounds; pass both on every windowed call.
- For HTTP APIs, encode cursors with `encodeCursor` / `decodeCursor` from `neoorm`.
- On feed tables, add a composite index on the sort columns.

Walk backward (e.g. “load newer” on a descending feed):

```ts
const newer = await db.posts.paginate({
  where: { published: true },
  orderBy: { createdAt: "desc" },
  take: 20,
  before: page.prevCursor,
});
```

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
  _count: { _all: true, authorId: true },
  _avg: { views: true },
});
// { _count: { _all: number, authorId: number }, _avg: { views: number | null } }
```

`_count: true` is still `COUNT(*)` and returns `_count: number`. A field map uses `COUNT(col)` (nulls are skipped) — not `DISTINCT`.

Single-table grouped stats use `groupBy()`. Cross-table dashboards still use `db.sql` (same compiler as `neoorm/sql`) or `sqlBuilder` composed into `db.sql`. See [Raw SQL & logging](raw-sql.md).

### `groupBy()`

```ts
const byAuthor = await db.posts.groupBy({
  by: ["authorId"],
  where: { published: true },
  _count: { _all: true, authorId: true },
  _avg: { views: true },
  having: { _count: { _all: { gte: 5 }, authorId: { gt: 0 } } },
  orderBy: { _count: { _all: "desc" } },
  take: 10,
});
// { authorId: string, _count: { _all: number, authorId: number }, _avg: { views: number | null } }[]
```

Star `_count: true` still works with `having: { _count: { gte: 5 } }` and `orderBy: { _count: "desc" }`.

`where` filters rows before grouping. `having` filters groups (aggregates only). `by` alone lists distinct groups — useful when you need grouped aggregates rather than `findMany({ distinct })`.

## Count

```ts
const total = await db.users.count({ where: { active: true } });
const uniqueEmails = await db.users.count({ distinct: "email" });
const fieldCounts = await db.users.count({
  select: { _all: true, email: true },
});
// { _all: number, email: number }

const taken = await db.users.exists({ where: { email: "a@b.com" } });
```

`count()` returns a number unless `select` is set. `distinct` is `COUNT(DISTINCT col)` on one column and cannot be combined with `select`. Field `select` / `_count` maps are non-null `COUNT(col)`, not distinct.

`exists()` runs `SELECT 1 … LIMIT 1` and returns a boolean. Use `count()` when you need the actual number of matches.
