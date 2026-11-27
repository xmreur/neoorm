---
title: Raw SQL & logging
description: Parameterized `db.sql`, `sqlBuilder`, `db.execute`, and query logging.
group: queries
order: 60
---

# Raw SQL & logging

Drop down to parameterized SQL whenever a query needs CTEs, window functions, or custom reporting, and hook into query execution with `beforeQuery` / `afterQuery`.

## Raw SQL

`db.sql` and `import { sql } from "neoorm/sql"` share one compiler. Interpolate values, `sqlId("table")`, nested `sql\`...\`` fragments, or `sqlBuilder.compile()`. `sqlBuilder` covers select/join/where/group/order/limit with bound params; use `db.sql` for `HAVING` and other raw tails.

```ts
import { sql, sqlBuilder, sqlId } from "neoorm/sql";

const ident = sqlId("users");
const filter = sql`email = ${"a@b.com"}`;
const rows = await db.sql`SELECT * FROM ${ident} WHERE ${filter}`;

const grouped = sqlBuilder
  .selectFrom("users")
  .select(["id", "email"])
  .where("email", "=", "a@b.com")
  .orWhere(sql`role = ${"admin"}`)
  .groupBy("id", "email")
  .limit(10)
  .compile();
await db.sql`${grouped} HAVING count(*) > ${0}`;
```

`db.execute({ text, params })` runs already-compiled SQL. With PostgreSQL tenant `schema`, `db.sql` / `db.execute` qualify unqualified manifest table names (same as `db.sqlId("users")`). Already-qualified `schema.table` identifiers are unchanged.

## Logging SQL

Pass `beforeQuery` / `afterQuery` when creating the client. They run for repository methods and `db.sql` / `db.execute`, including queries inside `$transaction`. `BEGIN` / `COMMIT` / `SAVEPOINT` are not included.

```ts
const db = createNeoOrmClient(manifest, {
  afterQuery: ({ sql, params, durationMs, error }) => {
    if (error || durationMs > 100) {
      console.warn({ sql, params, durationMs, error });
    }
  },
});
```
