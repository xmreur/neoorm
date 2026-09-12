# Common errors

NeoOrm surfaces structured errors with dialect-agnostic codes, optional subclasses for constraint violations, and fix suggestions. Catch them programmatically or read the CLI output after `neoorm generate` / query failures.

## Error types

- **`NeoOrmError`** — base class for all NeoOrm errors
- **`NeoOrmSchemaError`** — schema compilation (`neoorm generate`) or migration failures
- **`NeoOrmQueryError`** — query builder mistakes (compile phase) or database runtime failures
- **Constraint subclasses** — `UniqueViolationError`, `ForeignKeyViolationError`, `NotNullViolationError`, `CheckViolationError`, `InvalidInputError`, `SchemaDriftError`
- **`QueryCompileError`** — compile-time query builder mistakes (`phase: "compile"`)

Every error exposes **`err.code`** (typed string) and **`err.context`** with `detail`, `suggestions`, and optional table/column metadata.

```ts
import {
  UniqueViolationError,
  ForeignKeyViolationError,
  NeoOrmQueryError,
  QueryErrorCode,
  isUniqueViolation,
} from "neoorm";

try {
  await db.users.create({ data: { email: "a@b.com" } });
} catch (err) {
  if (err instanceof UniqueViolationError) {
    return { status: 409, column: err.context.columnTsName };
  }
  if (err instanceof ForeignKeyViolationError) {
    return { status: 400 };
  }
  if (err instanceof NeoOrmQueryError) {
    switch (err.code) {
      case QueryErrorCode.not_null_violation:
      case QueryErrorCode.invalid_input:
        return { status: 400 };
      default:
        throw err;
    }
  }
  throw err;
}
```

Type guards (`isUniqueViolation`, `isQueryCompileError`, `isNeoOrmError`, …) are exported for bundle-boundary safety.

## Query error codes

Codes are **dialect-agnostic** — the same `unique_violation` code is used for PostgreSQL and SQLite.

| Code | Subclass | Typical HTTP | When |
|------|----------|--------------|------|
| `unique_violation` | `UniqueViolationError` | 409 | Duplicate unique key |
| `foreign_key_violation` | `ForeignKeyViolationError` | 400 | Missing parent row |
| `not_null_violation` | `NotNullViolationError` | 400 | Required column null |
| `check_violation` | `CheckViolationError` | 400 | Check/enum rejected |
| `invalid_input` | `InvalidInputError` | 400 | Type mismatch (PG `22P02`) |
| `relation_not_found` | `SchemaDriftError` | 500 | Table missing (PG `42P01`) |
| `column_not_found` | `SchemaDriftError` | 500 | Column missing (PG `42703`) |
| `empty_returning` | — | 500 | INSERT … RETURNING returned no row |
| `connection_error` | — | 503 | `$connect` failed |
| `unknown_table` | `QueryCompileError` | 400 | Bad table accessor |
| `unknown_column` | `QueryCompileError` | 400 | Bad column in where/select/omit/groupBy |
| `invalid_args` | `QueryCompileError` | 400 | Unsupported where/having operator |
| `unique_where_invalid` | `QueryCompileError` | 400 | update/delete where not unique |
| `where_required` | `QueryCompileError` | 400 | update/delete missing where |

PostgreSQL SQLSTATE is preserved on `err.context.pgCode` when available.

`findUnique` / `findFirst` return `null` when no row is found — they do not throw a not-found error.

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

Filters, `select`, `omit`, `orderBy`, `groupBy`, and `create`/`update` `data` use **TypeScript property names** from your schema, not SQL `snake_case` names. Unknown keys fail at compile time (`unknown_column`).

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
