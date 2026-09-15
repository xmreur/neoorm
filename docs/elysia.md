# Elysia schemas

`neoorm generate` can print Select, Create, and Update **scalar** Elysia `t` schemas next to the typed client. Codegen maps your schema to a validator-neutral IR first; this printer emits `import { t } from "elysia"` so the objects drop into route `body:` / `query:` the same way as hand-written `t.Object({ title: t.String() })`.

Generated schemas match the TypeScript shapes of row / insert / update scalars — not nested relation writes (`connect`, `create`, `set`). Those stay TypeScript-only.

This is the printer to use with **Elysia 1.x**. [TypeBox 1.x](typebox.md) (`import Type from "typebox"`) is a different package and will not type-check as Elysia `body:`.

## Enable

Install Elysia in the app, then opt in:

```bash
bun add elysia
```

```ts
// neoorm.config.ts
import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: {
    provider: "postgresql",
    url: process.env.DATABASE_URL!,
  },
  generate: {
    elysia: true,
  },
});
```

Re-run `neoorm generate` (or `neoorm migrate dev`). Output:

- `out/elysia.ts` — generated schemas
- `out/client.ts` re-exports them

Disable `generate.elysia` and generate again to remove `elysia.ts`.

`elysia` is an optional peer of NeoOrm. The generated file imports `elysia` directly; NeoOrm does not bundle it. If `generate.elysia` is on and `elysia` is not installed, `neoorm generate` still writes `elysia.ts` and prints a warning (`bun add elysia`).

When Zod or TypeBox 1.x is also enabled, `client.ts` keeps those as documented and re-exports Elysia as `export * as elysia from "./elysia.js"` so names do not collide. Import from `./elysia.js` (or `elysia.UserCreateSchema`) in that case.

## Usage

```ts
import { Elysia } from "elysia";
import { db, UserCreateSchema, UserUpdateSchema } from "./neoorm/client.js";

new Elysia()
  .post("/users", ({ body }) => db.users.create({ data: body }), {
    body: UserCreateSchema,
  })
  .patch("/users/:id", ({ params, body }) =>
    db.users.update({
      where: { id: params.id },
      data: body,
    }), {
      body: UserUpdateSchema,
    },
  )
  .listen(3000);
```

Elysia validates `body` against the `t.Object` schema. `t.Date()` accepts ISO-8601 strings, `Date` values, and epoch numbers, and decodes to `Date`.

Per table (accessor `users` → model `User`):

| Export | Shape |
|--------|--------|
| `UserSchema` / `UserSelect` | Select row (default query output: no `.hidden()`, includes `timestamps()`) |
| `UserCreateSchema` / `UserCreate` | Insert scalars (no primary / serial / `timestamps()`; defaults optional; includes `.hidden()`) |
| `UserUpdateSchema` / `UserUpdate` | Update scalars (no primary / `timestamps()`; all optional; includes `.hidden()`) |

`UserSelect` / `UserCreate` / `UserUpdate` are `typeof Schema.static` aliases. They are named that way so they do not collide with the model type `User` from `models.ts`. Hoisted enums also get a type (`PostStatus` from `PostStatusSchema`).

`schemas.users.select` / `.create` / `.update` are the same objects.

`.hidden()` columns (for example `password`) are omitted from select schemas so they match default query results. They stay on create and update so login/register and password-change payloads can still be parsed. Use `includeHidden: true` on the query when the app needs those fields internally.

`createdAt` and `updatedAt` from `timestamps()` (and any `timestamp().defaultNow()` / `.updatedAt()` column) are ORM-managed. They appear on select schemas only — create and update parsers reject them so API clients cannot stamp those fields. A plain `timestamp()` without `defaultNow` stays on create/update.

Create with `author: { connect: { id } }` is not in `PostCreateSchema`. Pass the FK scalar (`authorId`) or keep nested writes in TypeScript.

## Junction (M2M) tables

Many-to-many through tables (auto `posts_tags` from `tags: many("tags")`, or an explicit `through` table) are not ordinary entities. Both FK columns are usually the composite primary key, so a naive Create/Update export would be `t.Object({})`.

Codegen treats them as **link** tables:

| Export | Shape |
|--------|--------|
| `{Model}Schema` / `{Model}Select` | Junction row (both FK ids, plus extras like `priority`) |
| `{Model}LinkCreateSchema` / `{Model}LinkCreate` | Both FK ids required; extra create-allowed columns |
| `{Model}CreateSchema` / `{Model}Create` | Alias of `LinkCreateSchema` |
| `{Model}UpdateSchema` | Extra scalar columns only. **Omitted** when the junction has no updatable fields |

Generated comments point at nested writes on the parent (`db.posts.update({ data: { tags: { connect: [{ id }] } } })`). Direct `db.posts_tags.create` is rarely needed. `schemas.posts_tags` has `select` and `create`; `update` is present only when the through table has extra columns.

Prefer validating parent payloads in TypeScript (`tags: { connect, set, … }`). Junction Elysia schemas are for the rare case you insert a link row yourself.

## Types and constraints

`t.BigInt()` and `Buffer` still match generated models, not JSON. Wrap those fields if the payload is a JSON number/string.

Typed schema helpers map into Elysia `t`:

| Schema | Elysia |
|--------|--------|
| `.minLength()` / `.maxLength()` / `.notEmpty()` | `t.String({ minLength, maxLength })` |
| `email` / `*Email` column names, or `.email()` on `text` / `citext` | `t.String({ format: "email" })` |
| `url` / `*Url` column names, or `.url()` on `text` / `citext` | `t.String({ format: "uri" })` |
| `.min()` / `.max()` / `.positive()` on int/serial | `t.Integer({ minimum, maximum, exclusiveMinimum: 0 })` |
| same helpers on `bigint` | `t.BigInt({ minimum, maximum, exclusiveMinimum: 0n })` |
| same helpers on `decimal()` | `t.Transform(t.String()).Decode(...)` |
| `enumType([...])` | hoisted `t.UnionEnum` |
| `json()` / `jsonb()` with no type arg | `t.Record(t.String(), t.Unknown())` |
| `jsonb<Record<string, unknown>>()` | `t.Record(t.String(), t.Unknown())` |
| `jsonb<{ featured: boolean }>()` (inline object type) | `t.Object({ featured: t.Boolean(), … })` |
| `json()` / `jsonb()` with `.schema()` validation IR | same as IR (`t.Object`, nested `t.Record`, …); wins over generics |
| `timestamp()` | `t.Date()` (ISO string / Date / epoch → `Date`) |
| `bytea()` | `t.Transform(t.Any())` + `Buffer.isBuffer` |
| nullable / optional | `t.Nullable` / `t.Optional` |

Raw `.check("sql")` is not mapped. With `generate.elysia: true` (or Zod/TypeBox), codegen reads inline `json()` / `jsonb()` type arguments from `schema.ts`. Type aliases and imported types are not resolved yet — use an inline type or `.schema()` for those.

```ts
metadata: jsonb<{ featured: boolean; category?: string }>(),
// → metadata: t.Nullable(t.Object({ featured: t.Boolean(), category: t.Optional(t.String()) }))
```
