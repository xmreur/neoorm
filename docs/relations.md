# Relation writes

`create` and `update` accept nested relation writes alongside scalar fields. Relation-only updates are supported (no scalar `SET` required). Nested to-one `create` on `update` (and `create`) runs in the same transaction as the parent row so a failed parent write does not leave an orphan.

## Supported operations

| Relation kind | Operations |
|---------------|------------|
| **To-one** (outgoing FK) | `connect`, `create`, `disconnect` (nullable FK only) |
| **One-to-many** (inverse) | `create`, `connect`, `disconnect`, `set`, `delete` |
| **Many-to-many** | `connect`, `connectOrCreate`, `disconnect`, `set`, `delete` |

`connect`, `set`, `disconnect`, and `delete` identify related rows by the **target table's scalar primary key** (`{ id: ... }` when the PK is `id`, `{ userId: ... }` when it is `userId`). Composite-PK connect is not supported.

A relation field must be a **pure write bag**: every key is one of those operations. Mixing a write op with extra fields (`{ create: { name: "A" }, foo: 1 }`), passing a scalar, or passing `{}` throws `invalid_nested_write` — the parent row is not written.

## Examples

### To-one on update

```ts
await db.posts.update({
  where: { id: postId },
  data: { author: { connect: { id: userId } } },
});
```

### Nested create on one-to-many

```ts
await db.posts.update({
  where: { id: postId },
  data: {
    comments: {
      create: [{ body: "Hi", author: { connect: { id: userId } } }],
      connect: [{ id: commentId }],
      disconnect: [{ id: oldCommentId }], // or `true` to unlink all
      set: [{ id: commentId }],           // replace all links
      delete: [{ id: commentId }],        // or `true` to delete all linked children
    },
  },
});
```

### Many-to-many on create or update

```ts
await db.posts.update({
  where: { id: postId },
  data: {
    tags: {
      connect: [{ id: tagId }],
      set: [{ id: tagId }],
      connectOrCreate: [
        { where: { slug: "orm" }, create: { slug: "orm", name: "ORM" } },
      ],
      delete: [{ id: tagId }],
    },
  },
});
```

### Relation writes in updateMany

`updateMany` applies scalar `SET` once, then nested writes per matched parent:

```ts
await db.posts.updateMany({
  where: { published: true },
  data: {
    status: "archived",
    tags: { connect: [{ id: tagId }] },
  },
});
```

## Operation order

Within a single relation field, operations run in order: `delete` → `disconnect` → `set` → `connect` / `connectOrCreate` → `create`. Mixing `set` with `connect` or `create` is discouraged — `set` replaces the full link set.
