# Common errors

NeoOrm surfaces structured errors with explanations and fix suggestions. Catch them programmatically or read the CLI output after `neoorm generate` / query failures.

## Error types

- **`NeoOrmSchemaError`** — schema compilation (`neoorm generate`) or migration failures
- **`NeoOrmQueryError`** — query builder mistakes (compile phase) or database runtime failures

Both expose a `.context` object with `detail`, optional `code`, and `suggestions: string[]`.

```ts
import { NeoOrmQueryError, NeoOrmSchemaError } from "neoorm";

try {
  await db.users.create({ data: { email: "a@b.com" } });
} catch (err) {
  if (err instanceof NeoOrmQueryError) {
    console.error(err.message);
    console.error(err.context.suggestions);
  }
}
```

## Schema: use accessors, not SQL names

Foreign keys and `many()` targets refer to **schema accessors** (the keys in `defineSchema({ ... })`), not SQL table names.

```ts
// Wrong — "server_members" is the SQL table name
userId: fk("server_members")

// Right — "serverMembers" is the accessor
userId: fk("serverMembers")
```

If you see `Foreign key references unknown table accessor "server_members"`, check the suggestions block for the correct camelCase accessor.

## Queries: use TypeScript column names

Filters, `select`, `omit`, `orderBy`, and `groupBy` use **TypeScript property names** from your schema, not SQL `snake_case` names.

```ts
// Wrong
db.users.findMany({ where: { created_at: { gt: date } } });

// Right
db.users.findMany({ where: { createdAt: { gt: date } } });
```

## Schema drift

Runtime errors like missing tables/columns often mean the database is behind your schema:

1. Run `neoorm migrate dev` (or `neoorm migrate deploy` in production)
2. Regenerate the client with `neoorm generate`

`NeoOrmQueryError` may include a **Migration** line with pending migration info when schema drift is detected.

## After changing the schema

Always regenerate after editing `schema.ts`:

```bash
neoorm generate
```

If migrations are enabled, create and apply them:

```bash
neoorm migrate dev
```
