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

CLI commands load `.env` from the project directory before evaluating this file, so `process.env.DATABASE_URL` is set after `cp .env.example .env`. Variables already present in the environment are not overwritten. The generated client does not load `.env` at query time — use your runtime or a loader such as `node --env-file=.env`.

## Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `schema` | `string` | required | Path to the schema file |
| `out` | `string` | required | Output directory for generated files |
| `datasource.provider` | `"postgresql" \| "postgres" \| "sqlite"` | required | Database provider. `"postgres"` is an alias of `"postgresql"`. |
| `datasource.url` | `string` | required | Connection string (PostgreSQL) or database file path / `:memory:` (SQLite) |
| `datasource.schema` | `string` | `"public"` | PostgreSQL schema for migrations and queries (SQLite: not applicable) |
| `datasource.enum` | `"check" \| "union" \| "native"` | `"check"` | How to store enum columns |

### SQLite

Set `provider: "sqlite"` and `url` to a file path or `":memory:"`:

```ts
datasource: {
  provider: "sqlite",
  url: "./dev.db",
},
```

`datasource.schema` and `datasource.enum: "native"` are PostgreSQL-only and ignored on SQLite. See [SQLite](sqlite.md).

### Enum modes

| Mode | SQL | DB enforcement |
|------|-----|----------------|
| `check` (default) | `TEXT` + `CHECK (...)` | yes |
| `union` | `TEXT` | no (TypeScript union only) |
| `native` | Postgres `CREATE TYPE ... AS ENUM` | yes (PostgreSQL only) |
