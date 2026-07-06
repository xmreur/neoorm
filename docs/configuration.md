# Configuration

The `neoorm.config.ts` file configures schema location, output directory, and datasource.

```ts
// neoorm.config.ts
import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: {
    provider: "postgresql",
    url: process.env.DATABASE_URL!,
    schema: "public",
    enum: "check",
  },
});
```

## Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `schema` | `string` | required | Path to the schema file |
| `out` | `string` | required | Output directory for generated files |
| `datasource.provider` | `"postgresql"` | required | Database provider |
| `datasource.url` | `string` | required | Database connection string |
| `datasource.schema` | `string` | `"public"` | PostgreSQL schema for migrations and queries |
| `datasource.enum` | `"check" \| "union" \| "native"` | `"check"` | How to store enum columns |

### Enum modes

| Mode | SQL | DB enforcement |
|------|-----|----------------|
| `check` (default) | `TEXT` + `CHECK (...)` | yes |
| `union` | `TEXT` | no (TypeScript union only) |
| `native` | Postgres `CREATE TYPE ... AS ENUM` | yes |
