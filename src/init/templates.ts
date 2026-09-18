import type { InitProvider } from "../datasource-provider.js";

export function defaultDatabaseUrl(provider: InitProvider): string {
	switch (provider) {
		case "sqlite":
			return "./dev.db";
		case "mysql":
			return "mysql://root@localhost:3306/myapp";
		case "mariadb":
			return "mariadb://root@localhost:3306/myapp";
		case "postgresql":
			return "postgresql://postgres:postgres@localhost:5432/myapp";
		default: {
			const _never: never = provider;
			return _never;
		}
	}
}

export function neoormConfigTemplate(
	schemaPath: string,
	outDir: string,
	provider: InitProvider = "postgresql",
	databaseUrl?: string,
): string {
	const url = databaseUrl ?? defaultDatabaseUrl(provider);
	const urlLiteral =
		provider === "sqlite" && !databaseUrl
			? `"${url}"`
			: `process.env.DATABASE_URL ?? "${url}"`;
	return `import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "${schemaPath}",
  out: "${outDir}",
  datasource: {
    provider: "${provider}",
    url: ${urlLiteral},
    enum: "check",
  },
  // generate: { zod: true, typebox: true, elysia: true },
});
`;
}

export function schemaTemplate(): string {
	return `import {
  defineSchema,
  table,
  id,
  text,
  fk,
  many,
  timestamps,
} from "neoorm/schema";

export const schema = defineSchema({
  users: table({
    id: id(),
    email: text().notNull().unique(),
    ...timestamps(),
  }),

  posts: table({
    id: id(),
    authorId: fk("users").notNull().index(),
    title: text().notNull(),
    ...timestamps(),
    tags: many("tags"),
  }),

  tags: table({
    id: id(),
    name: text().notNull(),
  }),
});
`;
}

export function envExampleTemplate(
	provider: InitProvider = "postgresql",
	databaseUrl?: string,
): string {
	return `DATABASE_URL=${databaseUrl ?? defaultDatabaseUrl(provider)}
`;
}
