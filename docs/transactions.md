# Transactions

## Interactive callback

```ts
await db.$transaction(async (tx) => {
  const user = await tx.users.create({ data: { email: "a@b.com" } });
  await tx.posts.create({
    data: { title: "Hello", authorId: user.id },
  });
});
```

## Batch steps

Sequential, one transaction:

```ts
const [user, post] = await db.$transaction([
  (tx) => tx.users.create({ data: { email: "a@b.com" } }),
  (tx) => tx.posts.create({ data: { title: "Hello" } }),
]);
```

## Options

```ts
await db.$transaction(fn, {
  isolationLevel: "Serializable", // ReadUncommitted | ReadCommitted | RepeatableRead | Serializable
  readOnly: true,
});
```

## Nested transactions

Uses PostgreSQL savepoints on the same connection. A nested failure rolls back only that block; the outer transaction can continue.

```ts
await db.$transaction(async (tx) => {
  await tx.users.create({ data: { email: "outer@example.com" } });

  await tx.$transaction(async (nested) => {
    await nested.posts.create({
      data: { title: "Nested", body: "...", authorId: "user_1" },
    });
  }).catch(() => undefined);

  // Outer writes are kept even if the nested block failed.
});
```

Nested `create` calls inside a transaction do not start a separate transaction. `readOnly` and `isolationLevel` apply only to the outermost `BEGIN`.
