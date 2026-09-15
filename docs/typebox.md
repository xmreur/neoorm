# TypeBox schemas

`neoorm generate` can print Select, Create, and Update **scalar** TypeBox schemas next to the typed client. Codegen maps your schema to a validator-neutral IR first; TypeBox 1.x is one printer (alongside [Zod](zod.md) and [Elysia `t`](elysia.md)).

Generated schemas match the TypeScript shapes of row / insert / update scalars — not nested relation writes (`connect`, `create`, `set`). Those stay TypeScript-only.

Schemas target **TypeBox 1.x** (`typebox` on npm), not `@sinclair/typebox` 0.x. For Elysia 1.x route `body:`, use [`generate.elysia`](elysia.md) instead.

## Enable

Install TypeBox 1.x in the app, then opt in:

```bash
bun add typebox
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
    typebox: true,
  },
});
```

Re-run `neoorm generate` (or `neoorm migrate dev`). Output:

- `out/typebox.ts` — generated schemas
- `out/client.ts` re-exports them

Disable `generate.typebox` and generate again to remove `typebox.ts`.

`typebox` is an optional peer of NeoOrm. The generated file imports `typebox` directly; NeoOrm does not bundle it. If `generate.typebox` is on and `typebox` is not installed, `neoorm generate` still writes `typebox.ts` and prints a warning (`bun add typebox`).

You can enable Zod, TypeBox, and Elysia together. When Zod is on, `client.ts` keeps Zod as a flat `export *` and namespaces TypeBox and Elysia (`export * as typebox` / `export * as elysia`). TypeBox + Elysia without Zod keeps TypeBox flat and namespaces Elysia. Import TypeBox from `./typebox.js` (or `typebox.UserCreateSchema` from the client) when it is namespaced. For Elysia 1.x `body:`, use [`generate.elysia`](elysia.md).

## Usage

```ts
import Value from "typebox/value";
import { db, UserCreateSchema, type UserCreate } from "./neoorm/client.js";

const data: UserCreate = Value.Decode(UserCreateSchema, body);
await db.users.create({ data });
```

`Value.Check` returns a boolean and does not run codecs. Use `Value.Decode` when you need timestamp fields as `Date` (the TypeBox equivalent of Zod `parse`). Invalid data throws.

Per table (accessor `users` → model `User`):

| Export | Shape |
|--------|--------|
| `UserSchema` / `UserSelect` | Select row (default query output: no `.hidden()`, includes `timestamps()`) |
| `UserCreateSchema` / `UserCreate` | Insert scalars (no primary / serial / `timestamps()`; defaults optional; includes `.hidden()`) |
| `UserUpdateSchema` / `UserUpdate` | Update scalars (no primary / `timestamps()`; all optional; includes `.hidden()`) |

`UserSelect` / `UserCreate` / `UserUpdate` are `Type.StaticDecode` aliases. They are named that way so they do not collide with the model type `User` from `models.ts`. Hoisted enums also get a type (`PostStatus` from `PostStatusSchema`).

`schemas.users.select` / `.create` / `.update` are the same objects.

`.hidden()` columns (for example `password`) are omitted from select schemas so they match default query results. They stay on create and update so login/register and password-change payloads can still be parsed. Use `includeHidden: true` on the query when the app needs those fields internally.

`createdAt` and `updatedAt` from `timestamps()` (and any `timestamp().defaultNow()` / `.updatedAt()` column) are ORM-managed. They appear on select schemas only — create and update parsers reject them so API clients cannot stamp those fields. A plain `timestamp()` without `defaultNow` stays on create/update.

Create with `author: { connect: { id } }` is not in `PostCreateSchema`. Pass the FK scalar (`authorId`) or keep nested writes in TypeScript.

## Junction (M2M) tables

Many-to-many through tables (auto `posts_tags` from `tags: many("tags")`, or an explicit `through` table) are not ordinary entities. Both FK columns are usually the composite primary key, so a naive Create/Update export would be `Type.Object({})`.

Codegen treats them as **link** tables:

| Export | Shape |
|--------|--------|
| `{Model}Schema` / `{Model}Select` | Junction row (both FK ids, plus extras like `priority`) |
| `{Model}LinkCreateSchema` / `{Model}LinkCreate` | Both FK ids required; extra create-allowed columns |
| `{Model}CreateSchema` / `{Model}Create` | Alias of `LinkCreateSchema` |
| `{Model}UpdateSchema` | Extra scalar columns only. **Omitted** when the junction has no updatable fields |

Generated comments point at nested writes on the parent (`db.posts.update({ data: { tags: { connect: [{ id }] } } })`). Direct `db.posts_tags.create` is rarely needed. `schemas.posts_tags` has `select` and `create`; `update` is present only when the through table has extra columns.

Prefer validating parent payloads in TypeScript (`tags: { connect, set, … }`). Junction TypeBox is for the rare case you insert a link row yourself.

## Types and constraints

Timestamp columns accept both ORM `Date` values and JSON ISO-8601 strings (`2020-01-01T00:00:00.000Z`, including offsets). `Value.Decode` always returns a `Date`, so the same schema works for HTTP bodies and query results. `Value.Check` accepts either form without converting.

`Type.BigInt()` and `Buffer` still match generated models, not JSON. Wrap those fields if the payload is a JSON number/string.

The generated file registers `uuid`, `email`, `url`, and `date-time` on TypeBox’s `Format` registry when those formats appear, without overwriting a format you already set.

Typed schema helpers map into TypeBox:

| Schema | TypeBox |
|--------|---------|
| `.minLength()` / `.maxLength()` / `.notEmpty()` | `Type.String({ minLength, maxLength })` |
| `email` / `*Email` column names, or `.email()` on `text` / `citext` | `Type.String({ format: "email" })` |
| `url` / `*Url` column names, or `.url()` on `text` / `citext` | `Type.String({ format: "url" })` |
| `.min()` / `.max()` / `.positive()` on int/serial | `Type.Integer({ minimum, maximum, exclusiveMinimum: 0 })` |
| same helpers on `bigint` | `Type.BigInt({ minimum, maximum, exclusiveMinimum: 0n })` |
| same helpers on `decimal()` | `Type.Refine(Type.String(), …)` |
| `enumType([...])` | hoisted `Type.Enum` |
| `json()` / `jsonb()` with no type arg | `Type.Record(Type.String(), Type.Unknown())` |
| `jsonb<Record<string, unknown>>()` | `Type.Record(Type.String(), Type.Unknown())` |
| `jsonb<{ featured: boolean }>()` (inline object type) | `Type.Object({ featured: Type.Boolean(), … })` |
| `json()` / `jsonb()` with `.schema()` validation IR | same as IR (`Type.Object`, nested `Type.Record`, …); wins over generics |
| `timestamp()` | `Date` or ISO datetime string → `Date` (`Type.Codec` + `Value.Decode`) |
| `bytea()` | `Type.Refine` + `Buffer.isBuffer` |

Raw `.check("sql")` is not mapped. With `generate.typebox: true` (or `generate.zod` / `generate.elysia`), codegen reads inline `json()` / `jsonb()` type arguments from `schema.ts` and maps object literals to `Type.Object`, `Record<K,V>` to `Type.Record`, and primitives to the matching TypeBox types. Type aliases and imported types are not resolved yet — use an inline type or `.schema()` for those.

```ts
metadata: jsonb<{ featured: boolean; category?: string }>(),
// → metadata: Type.Union([Type.Object({ featured: Type.Boolean(), category: Type.Optional(Type.String()) }), Type.Null()])
```

For shapes codegen cannot infer from the generic, use `.schema()`:

```ts
metadata: jsonb().schema({
  kind: "object",
  fields: [
    {
      name: "featured",
      type: { kind: "boolean" },
      nullable: false,
      optional: false,
    },
  ],
}),
```
