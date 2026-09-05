# API docstring conventions

Contributor guide for TSDoc on NeoOrm public exports. Docstrings appear in IDE hovers and emitted `.d.ts` files.

## Scope

Document symbols exported from:

- `neoorm`
- `neoorm/schema`
- `neoorm/sql`
- `neoorm/plugins`
- `neoorm/plugins/postgis`

Skip internal helpers, `infer*` types, and anything not re-exported from an entry barrel.

## Format

- Use **TSDoc** (`/** ... */`) on exported functions, types, interfaces, and enum-like unions.
- Document **fluent builder methods** (`.notNull()`, `.onDelete()`, `.defaultNow()`, etc.) on the exported `ColumnBuilder`, `TimestampColumnBuilder`, and `FkBuilder` interfaces so IDE hovers work on chained calls.
- **First line**: imperative summary (`Define a schema from table accessors.`).
- **`@param` / `@returns`**: non-trivial functions.
- **`@default`**: option fields on config/types.
- **`@example`**: only for non-obvious DSL (FK inference, `many()`, relation writes). Keep to 3–8 lines; mirror [schema.md](schema.md).
- **`@deprecated`**: include `@see` pointing at the successor.
- **`@see`**: link to user docs when more detail is needed.

## Module banners

Each entry barrel starts with:

```ts
/**
 * @packageDocumentation
 * Brief description of this subpath import.
 */
```

## Do not

- Duplicate full [docs/](.) prose into comments.
- Document generated client output under `neoorm/client`.
- Add runtime behavior changes alongside docstrings.
