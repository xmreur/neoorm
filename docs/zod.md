# Zod schemas

`neoorm generate` can print Select, Create, and Update **scalar** Zod schemas next to the typed client. Codegen maps your schema to a validator-neutral IR first; Zod is the printer shipped today. Other libraries are not configurable yet.

Generated schemas match the TypeScript shapes of row / insert / update scalars — not nested relation writes (`connect`, `create`, `set`). Those stay TypeScript-only.

## Enable

Install Zod 4 in the app, then opt in:

```bash
bun add zod
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
    zod: true,
  },
});
```

Re-run `neoorm generate` (or `neoorm migrate dev`). Output:

- `out/zod.ts` — generated schemas
- `out/client.ts` re-exports them

Disable `generate.zod` and generate again to remove `zod.ts`.

`zod` is an optional peer of NeoOrm. The generated file imports `zod` directly; NeoOrm does not bundle it. If `generate.zod` is on and `zod` is not installed, `neoorm generate` still writes `zod.ts` and prints a warning (`bun add zod`).

## Usage

```ts
import { db, UserCreateSchema, type UserCreate } from "./neoorm/client.js";

const data: UserCreate = UserCreateSchema.parse(body);
await db.users.create({ data });
```

Per table (accessor `users` → model `User`):

| Export | Shape |
|--------|--------|
| `UserSchema` / `UserSelect` | Select row (default query output: no `.hidden()`, includes `timestamps()`) |
| `UserCreateSchema` / `UserCreate` | Insert scalars (no primary / serial / `timestamps()`; defaults optional; includes `.hidden()`) |
| `UserUpdateSchema` / `UserUpdate` | Update scalars (no primary / `timestamps()`; all optional; includes `.hidden()`) |

`UserSelect` / `UserCreate` / `UserUpdate` are `z.infer` aliases. They are named that way so they do not collide with the model type `User` from `models.ts`. Hoisted enums also get a type (`PostStatus` from `PostStatusSchema`).

`schemas.users.select` / `.create` / `.update` are the same objects.

`.hidden()` columns (for example `password`) are omitted from select schemas so they match default query results. They stay on create and update so login/register and password-change payloads can still be parsed. Use `includeHidden: true` on the query when the app needs those fields internally.

`createdAt` and `updatedAt` from `timestamps()` (and any `timestamp().defaultNow()` / `.updatedAt()` column) are ORM-managed. They appear on select schemas only — create and update parsers reject them so API clients cannot stamp those fields. A plain `timestamp()` without `defaultNow` stays on create/update.

Create with `author: { connect: { id } }` is not in `PostCreateSchema`. Pass the FK scalar (`authorId`) or keep nested writes in TypeScript.

## Types and constraints

Timestamp columns accept both ORM `Date` values and JSON ISO-8601 strings (`2020-01-01T00:00:00.000Z`, including offsets). `parse` always returns a `Date`, so the same schema works for HTTP bodies and query results.

`z.bigint()` and `Buffer` still match generated models, not JSON. Wrap those fields if the payload is a JSON number/string.

Typed schema helpers map into Zod:

| Schema | Zod |
|--------|-----|
| `.minLength()` / `.maxLength()` / `.notEmpty()` | `z.string().min()` / `.max()` |
| `email` / `*Email` column names, or `.email()` on `text` / `citext` | `z.email()` |
| `url` / `*Url` column names, or `.url()` on `text` / `citext` | `z.url()` |
| `.min()` / `.max()` / `.positive()` on int/serial/bigint | matching number/bigint checks |
| same helpers on `decimal()` | `z.string().refine(...)` |
| `enumType([...])` | hoisted `z.enum` |
| `json()` / `jsonb()` | `z.unknown()` |
| `timestamp()` | `Date` or ISO datetime string → `Date` |

Raw `.check("sql")` is not mapped. `jsonb<MyType>()` generics are erased — extend the field:

```ts
const PostCreateBody = PostCreateSchema.extend({
  metadata: z.record(z.string(), z.unknown()),
});
```
