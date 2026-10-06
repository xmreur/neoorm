# Seeding

`neoorm seed` runs a seed script against the database inside a single transaction. Any failure rolls the whole seed back, so failed runs are safe to retry.

```
neoorm seed [--env <name>] [--file <path>]
```

## Seed files

By convention the seed lives next to the schema as `seed.ts` and exports a `seed(db)` function. `db` is a transaction-scoped client, so every write in the file is atomic:

```ts
// seed.ts
import type { TransactionClient } from "neoorm";
import { schema } from "./schema.js";

export async function seed(db: TransactionClient<typeof schema._tables>) {
	await db.users.upsert({
		where: { email: "admin@example.com" },
		create: { email: "admin@example.com", name: "Admin" },
		update: {},
	});
	await db.tags.createMany({
		data: [
			{ slug: "news", name: "News" },
			{ slug: "guides", name: "Guides" },
		],
		skipDuplicates: true,
	});
}
```

Annotating with `TransactionClient<typeof schema._tables>` gives fully typed repositories — the same types as the generated client. A default-exported function works too, and `SeedContext` from `neoorm` is available for manifest-agnostic helpers.

## Environments

`--env <name>` runs `seeds/<name>.ts` instead of `seed.ts`:

```bash
neoorm seed --env dev
neoorm seed --file ./seeds/manual.ts
```

`--file` wins over `--env`, and both win over config (see below).

## Idempotency

Seeds are re-run by convention — there is no seed ledger. Write seeds so running them twice is safe: `upsert`, `findOrCreate`, and `createMany({ skipDuplicates: true })` are the building blocks. The transaction guarantees all-or-nothing per run, not across runs.

## Configuration

Pin defaults in `neoorm.config.ts` (CLI flags override them):

```ts
export default defineConfig({
	// ...
	seed: { env: "dev", file: "./seeds/base.ts" },
});
```

| Key | Type | Description |
|-----|------|-------------|
| `seed.file` | `string` | Default seed file, project-root relative |
| `seed.env` | `string` | Default environment, runs `seeds/<env>.ts` next to the schema |

See [Configuration](configuration.md) for the full config reference.
