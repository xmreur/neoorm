---
title: Queries
description: Find, create, update, delete, upsert, and findOrCreate.
group: queries
order: 10
---

# Queries

Every table in your schema generates a typed repository on `db` (`db.users`, `db.posts`, …). This page covers core CRUD operations. For deeper query features, see [Filters & aggregates](filters.md), [Eager loading & projection](loading.md), [Nested writes](relations.md), and [Raw SQL & logging](raw-sql.md).

## Find

```ts
// By ID (scalar primary key — pass a string)
const user = await db.users.findById(id);

// By composite primary key — pass an object with all PK columns
const item = await db.items.findById({ tenantId: "t1", itemCode: "c1" });

// First match (null if not found)
const user = await db.users.findFirst({ where: { email: "a@b.com" } });

// All matching
const users = await db.users.findMany({
  where: { published: true },
  take: 20,
  skip: 40,
});

// First match after skip, or with DISTINCT ON (null if not found)
await db.users.findFirst({ orderBy: { email: "asc" }, skip: 1 });
await db.users.findFirst({
  distinct: ["email"],
  orderBy: { email: "asc" },
});

// Unique constraint lookup
const user = await db.users.findUnique({ where: { slug: "hello" } });
```

Unique `where` (`findUnique`, `upsert`, `findOrCreate`) is scalar equality per unique field — `{ email: "a@b.com" }`, not a filter. `{ equals: value }` is accepted and unwrapped to the scalar. Other operators (`contains`, `in`, `mode: "insensitive"`) throw `unique_where_invalid`. Partial unique indexes are valid targets: pass the indexed columns; the index `WHERE` is applied automatically so the lookup stays unique. Singular `update`/`delete` start from the same unique identification but additionally accept extra filter fields, which are `AND`'d onto the statement (see below).

## Create

```ts
const created = await db.users.create({ data: { email: "a@b.com" } });
created.id; // primary key is always returned

// Pass returnCreated: true to get the full row (defaults, timestamps, …)
const user = await db.users.create({
  data: { email: "a@b.com" },
  returnCreated: true,
});

// `with` also returns the full row (plus relations)
const post = await db.posts.create({
  data: { title: "Hello", body: "…", authorId: user.id },
  with: { author: true },
});

// Bulk insert (returns count)
const count = await db.users.createMany({
  data: [{ email: "a@b.com" }, { email: "b@b.com" }],
});

// Skip unique / primary-key conflicts (`ON CONFLICT DO NOTHING`).
// Does not ignore CHECK or foreign-key violations.
const skipped = await db.users.createMany({
  data: [{ email: "a@b.com" }, { email: "a@b.com" }],
  skipDuplicates: true,
});

// Bulk insert with returned rows (serial IDs, UUIDs, defaults materialized)
const users = await db.users.createManyAndReturn({
  data: [{ email: "a@b.com" }, { email: "b@b.com" }],
  skipDuplicates: true,
});
```

On MySQL (no `RETURNING`), serial-PK batches are hydrated with a follow-up re-select so DB-side defaults come back too; MariaDB uses `RETURNING` directly. With `skipDuplicates`, that re-select covers only the rows this statement inserted: serial keys from `LAST_INSERT_ID()` for the inserted count, and client-supplied primary keys that were not already in the table.

Unknown keys in `data` fail at compile time (`unknown_column`), same as `where`.

## Update

Singular `update` requires a unique `where` (primary key, `@unique` column, composite unique index, or partial unique index). Extra filter fields are allowed and compiled as additional `AND` predicates, so conditional single-row writes stay atomic — if the extras do not match, the update touches 0 rows and returns `null`. Use `updateMany` when there is no unique identifier.

```ts
// Revoke a session only if it is still unrevoked (one statement)
await db.sessions.update({
  where: { token, revokedAt: { isNull: true } },
  data: { revokedAt: new Date() },
});
```

```ts
// Returns {} on success, null if no row matched
const updated = await db.users.update({
  where: { id: userId },
  data: { email: "new@b.com" },
});

// Pass returnUpdated: true to get the updated row back
const user = await db.users.update({
  where: { id: userId },
  data: { email: "new@b.com" },
  returnUpdated: true,
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

const updated = await db.users.updateManyAndReturn({
  where: { email: { contains: "@old" } },
  data: { status: "archived" },
});

const post = await db.posts.update({
  where: { id: postId },
  data: { title: "New" },
  with: { author: true }, // full row plus relations; no returnUpdated needed
});
```

Numeric columns (`int`, `serial`, `decimal`, `bigint`) also accept `{ increment }`, `{ decrement }`, `{ multiply }`, and `{ set }`. These compile to `col = col ±/* $n` so concurrent updates do not clobber each other. `{ set: value }` is the same assignment as a plain value. `NULL + 1` stays SQL NULL.

```ts
await db.posts.update({
  where: { id: postId },
  data: { views: { increment: 1 } },
});

await db.posts.updateMany({
  where: { published: true },
  data: { views: { multiply: 2 } },
});
```

On dialects without `RETURNING` (MySQL; MariaDB for updates), `returnUpdated` / `updateManyAndReturn` re-select the rows after writing: by primary key when the table has one (composite keys included), otherwise by the original predicate. PK-less re-selects return currently-matching rows, so if `data` changed a filtered column the result may differ from the pre-update set.

Top-level to-one relation filters in `updateMany` compile to `UPDATE..JOIN` on MySQL/MariaDB (automatic) instead of `EXISTS` subqueries; pass `useJoin: true` for the `UPDATE..FROM` form on PostgreSQL (`useJoin: false` forces `EXISTS`). To-many (`some`/`every`/`none`), M2M, and nested filters always use `EXISTS`. SQLite has no join form — `useJoin: true` fails there.

## Delete

Singular `delete` requires a unique `where`. Like `update`, it accepts extra filter fields that are `AND`'d onto the statement — a miss deletes 0 rows and returns `null`. Use `deleteMany` for bulk deletes.

```ts
// Returns {} on success, null if no row matched
await db.users.delete({ where: { id: userId } });

// Pass returnDeleted: true to get the deleted row back
const deleted = await db.users.delete({
  where: { id: userId },
  returnDeleted: true,
});

// `with` also returns the full row (plus relations), even without returnDeleted
const post = await db.posts.delete({
  where: { id: postId },
  with: { author: true },
});

// Scalar PK — pass a string
await db.users.deleteById(userId);

// Composite PK — pass an object
await db.items.deleteById({ tenantId: "t1", itemCode: "c1" });

const count = await db.users.deleteMany({
  where: { email: { contains: "@spam" } },
});

const deletedRows = await db.users.deleteManyAndReturn({
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

Postgres issues `INSERT … ON CONFLICT DO UPDATE` with a no-op assignment so `RETURNING` always includes the row — including when a concurrent session already inserted it. `created` is `(xmax = 0)` (inserted vs existing). A no-op update can fire `UPDATE` triggers; column values are not changed.

Under `SERIALIZABLE` (and sometimes `REPEATABLE READ`), a concurrent insert can still abort the transaction with a serialization failure. Retry the whole `$transaction`. SQLite, MySQL, and MariaDB use find-then-insert and retry the find after a unique violation.

```ts
const { record, created } = await db.tags.findOrCreate({
  where: { slug: "orm" },
  create: { slug: "orm", name: "ORM" },
});
// created: true if a new row was inserted, false if an existing row was returned
```
