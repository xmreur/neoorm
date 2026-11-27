---
title: Validation
description: Compare Zod, TypeBox 1.x, and Elysia `t` schema codegen.
group: validation
order: 10
---

# Validation

`neoorm generate` can emit runtime validation schemas alongside your typed client from a single validator-neutral IR. Each table gets **Select**, **Create**, and **Update** scalar schemas that stay in sync with your database columns and constraints.

## Supported printers

| Printer | Config flag | Output file | Peer dependency | Guide |
|---------|-------------|-------------|-----------------|-------|
| **Zod 4** | `generate.zod: true` | `out/zod.ts` | `zod@^4` | [Zod schemas](zod.md) |
| **TypeBox 1.x** | `generate.typebox: true` | `out/typebox.ts` | `typebox@^1` | [TypeBox schemas](typebox.md) |
| **Elysia `t`** | `generate.elysia: true` | `out/elysia.ts` | `elysia>=1.2` | [Elysia schemas](elysia.md) |

> [!TIP]
> Building an Elysia 1.x server? Use `generate.elysia` rather than `generate.typebox` — Elysia bundles its own `t` schema types, so standalone TypeBox 1.x objects will not type-check as route `body:`.

## Enabling codegen

```ts
// neoorm.config.ts
import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: { provider: "postgresql", url: process.env.DATABASE_URL! },
  generate: {
    zod: true,
    // typebox: true,
    // elysia: true,
  },
});
```

## Shared constraints from `schema.ts`

Column helpers in [Schema DSL](schema.md#typed-constraint-helpers) flow directly into all three printers:

- `.maxLength(n)`, `.minLength(n)`, `.notEmpty()` → string length rules
- `.min(n)`, `.max(n)`, `.positive()` → numeric bounds
- `.email()` / `.url()` (and columns named `email`, `*Email`, `url`, `*Url`) → email / URL string formats
- `.notNull()`, `.default(...)`, `id()`, `serial()`, `timestamps()` → required vs optional fields on Create and Update schemas
- `enumType([...])` → literal union / enum validators

## Combining multiple printers

You can enable more than one printer at the same time. When Zod is enabled, `out/client.ts` re-exports Zod schemas flat (`export *`) and namespaces TypeBox and Elysia (`export * as typebox`, `export * as elysia`) to avoid symbol collisions. When TypeBox and Elysia are enabled without Zod, TypeBox is flat and Elysia is namespaced.
