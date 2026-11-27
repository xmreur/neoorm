---
title: Schema relations
description: Foreign keys, composite keys, self-relations, and many-to-many tables.
group: schema
order: 20
---

# Schema relations

NeoORM models relations directly on your schema tables using `fk()`, table-level `foreignKey()`, and virtual `many()` columns. All targets reference **schema accessors**, never raw SQL table names.

For reading relations with `with`, see [Eager loading & projection](loading.md). For writing nested relations, see [Nested writes](relations.md).

## Foreign keys

`fk()` targets are **schema accessors**, never SQL table names.

| Target | Example | Resolves to |
|--------|---------|-------------|
| accessor | `fk("users")` | target table PK |
| accessor + column | `fk("users.id")` | that column |
| hoisted table | `fk(users)` | target PK |
| hoisted column | `fk(users.id)` | that column |

```ts
posts: table({
  id: id(),
  authorId: fk("users")
    .notNull()
    .index()
    .onDelete("restrict"),
}),
```

Relation names are inferred — no `.inverse()` needed on the happy path:

- `authorId` → `author` on `posts` (`with: { author: true }`)
- inverse on `users` → `posts` (`with: { posts: true }`)

Fluent modifiers (no options bag):

| Method | Effect |
|--------|--------|
| `.as("author")` | override relation name on this table (default: strip `Id` from column name) |
| `.inverse("articles")` | override relation name on the target table (rare — see defaults below) |
| `.onDelete("cascade" \| "restrict" \| "set null" \| "no action")` | FK `ON DELETE` |
| `.onUpdate("cascade" \| "restrict" \| "set null" \| "no action")` | FK `ON UPDATE` |
| `.deferrable("immediate" \| "deferred")` | `DEFERRABLE` (Postgres and SQLite; rejected on MySQL/MariaDB) |
| `.notNull()` | `NOT NULL` |
| `.unique()` | `UNIQUE` — unique FKs infer a **singular** inverse (`profiles.userId` → `users.profile`) |
| `.primary()` | part of composite PK |
| `.index()` | single-column index |

Default inference when `.as()` / `.inverse()` are omitted:

- **this table:** `authorId` → `author` (strip trailing `Id`)
- **target table (to-many):** source accessor (`posts.authorId` → `users.posts`)
- **target table (unique to-one):** singular of source accessor (`profiles.userId` → `users.profile`)

### Composite primary keys with FKs

```ts
postTags: table("post_tags", {
  postId: fk("posts").primary(),
  tagId: fk("tags").primary(),
}),
```

Multiple `.primary()` columns infer a composite key. `primaryKey(t.colA, t.colB)` in extras is optional when you want to name the key without marking every column.

### Composite foreign keys

Use table extras `foreignKey()` when several local columns form one constraint (and one relation). Do not also mark those columns `fk()`.

```ts
orders: table(
  {
    id: id(),
    tenantId: text().notNull(),
    userId: text().notNull(),
  },
  (t) => [
    foreignKey(t.tenantId, t.userId)
      .references("users", "tenantId", "id")
      .as("user")
      .inverse("orders")
      .onDelete("cascade")
      .onUpdate("cascade"),
  ],
),
```

The target column list must match a primary key or unique index. `.as()` and `.inverse()` are required. Connect still uses the target table's full primary key:

```ts
await db.orders.create({
  data: {
    tenantId: "acme",
    user: { connect: { tenantId: "acme", id: userId } },
  },
});
```

### Self-relations

```ts
comments: table({
  id: id(),
  parentId: fk("comments").as("parent").inverse("children"),
  body: text().notNull(),
}),
```

### Hoisted table references

```ts
const users = table({ id: uuid().primary() });

export const schema = defineSchema({
  users,
  posts: table({
    authorId: fk(users).notNull().index(),
  }),
});
```

## Many-to-many

Declare a virtual column on the source table:

```ts
posts: table({
  id: id(),
  title: text().notNull(),
  tags: many("tags"),
}),
tags: table({ id: id(), slug: text().notNull().unique() }),
```

- `"tags"` is the **target accessor**.
- Junction table is auto-generated when `through` is omitted.
- SQL name: alpha-sorted SQL table names joined with `_` (e.g. `posts_tags` — no leading `_`).
- Accessor equals that identifier (`posts_tags`).

Reuse an existing junction by **accessor**:

```ts
posts: table({
  tags: many("tags", {
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

`as` / `inverse` override relation names on source and target tables.

Virtual M2M columns are relations only — they appear in `with`, relation filters, and relation writes, not in scalar `select`/`where`/`create` data.
