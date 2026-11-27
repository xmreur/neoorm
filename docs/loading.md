---
title: Eager loading & projection
description: Eager loading with `with`, `select`/`omit`, `.hidden()`, and `.strip()`.
group: queries
order: 30
---

# Eager loading & projection

Load related records in minimal SQL round-trips with `with`, narrow returned columns with `select` or `omit`, and keep sensitive fields out of API responses with `.hidden()` and `.strip()`.

## Eager loading with `with`

Relations are eagerly loaded in `findMany`, `findFirst`, and `findById` via the `with` option.

### Strategy

NeoORM uses a relation-loading planner that picks the fewest round-trips per `with` tree:

- **LEFT JOIN** — to-one relations where the parent table owns the foreign key are resolved in the main query. No additional round-trips.
- **JOIN + `json_agg`** — a single inverse has-many include may use one collection `LEFT JOIN` with `GROUP BY`. A second collection is a correlated subquery so sizes N and M do not become N×M rows.
- **Correlated `json_agg` subquery** — inverse has-many relations (and simple linear nested chains) are embedded in the main `SELECT` as correlated subqueries. Multiple top-level relations can be inlined in the same query alongside JOINs.
- **Inline `COUNT` subquery** — simple `_count` on has-many relations is embedded in the main `SELECT`. At most one `_count` collection uses a `LEFT JOIN`; additional counts are correlated `COUNT(*)` subqueries.
- **Batch query** — many-to-many, nested `with` on to-one, sibling-heavy trees, and other complex shapes fall back to batched `WHERE IN (...)` queries (one per relation level). Sibling batch queries at the same level run in parallel. Nested `take`/`skip` on those batches apply **per parent** (window ranking), not to the whole `IN` list.

Typical query counts:

- `with: { author: true }` → **1** query (JOIN)
- `with: { posts: true }` → **1** query (`json_agg` subquery)
- `with: { author: true, comments: true }` → **1** query (JOIN + `json_agg`)
- `with: { posts: { with: { comments: { with: { author: true } } } } }` on a linear chain → **1** query (nested `json_agg`)
- M2M or sibling nested relations → **1 + batch levels** (parallel per level)

```ts
// Single query — author via LEFT JOIN
const posts = await db.posts.findMany({ with: { author: true } });

// Last 5 published comments per post
const posts = await db.posts.findMany({
  with: {
    comments: {
      where: { published: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    },
  },
});

// Single query — author via JOIN, comments via correlated json_agg
const posts = await db.posts.findMany({
  with: { author: true, comments: { with: { author: true } } },
});
```

To-one includes with `where` load as a batch query: the relation is the matching row, or `null`.

## Selective return types

Root `select` and `omit` project the parent row. Relation shapes still come from `with` (including nested `select`). `select` and `omit` cannot be used together.

```ts
const users = await db.users.findMany({
  select: { id: true, email: true },
  with: { posts: { select: { title: true } } },
});
// { id, email, posts: Array<{ title }> }

const publicUsers = await db.users.findMany({
  omit: { createdAt: true, updatedAt: true },
});
```

Nested relation `select` also narrows the TypeScript return type:

```ts
const users = await db.users.findMany({
  with: { posts: { select: { title: true } } },
});
// users[0].posts[0].title is string; .body is excluded from the type
```

## Sensitive columns (`.hidden()`) and API responses (`strip`)

Mark sensitive columns in the schema with `.hidden()`:

```ts
password: text().notNull().hidden(),
```

By default, queries **omit** hidden columns from the result (root table and nested `with` includes). Pass `includeHidden: true` when the app needs them (for example password verification on login):

```ts
const user = await db.users.findFirst({
  where: { email: input.email },
  includeHidden: true,
});
```

Nested includes follow the same rule:

```ts
const posts = await db.posts.findMany({
  with: { author: true }, // author.password omitted
});

const posts = await db.posts.findMany({
  with: { author: { includeHidden: true } },
});
```

You can still use `select` to fetch a subset that includes hidden columns. Use query `omit` to skip non-hidden columns you do not want fetched. Use `.strip()` when you fetched sensitive fields internally but want a safe object for the response:

```ts
const user = await db.users.findById(id, { includeHidden: true });
if (!user) return null;
return user.strip(); // plain object without password

return user.strip({ refreshToken: true }); // hidden + extra column keys
```

`.strip()` is attached when the table has `.hidden()` columns (and on nested `with` rows that do). It is non-enumerable, recurses into nested relations, and returns a plain object (no `.strip` method) suitable for JSON responses.
