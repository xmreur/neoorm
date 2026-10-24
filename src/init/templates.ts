import type { InitProvider } from "../datasource-provider.js";
import { escapeTsString } from "../utils/case.js";

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
			? `"${escapeTsString(url)}"`
			: `process.env.DATABASE_URL ?? "${escapeTsString(url)}"`;
	return `import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "${escapeTsString(schemaPath)}",
  out: "${escapeTsString(outDir)}",
  datasource: {
    provider: "${escapeTsString(provider)}",
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

function needsEnvQuotes(value: string): boolean {
	if (/[\s#"'\\]/.test(value)) return true;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

/**
 * One dotenv value. Values that would break a raw line (quotes,
 * whitespace, comments, backslashes, controls) are double-quoted.
 */
export function formatEnvValue(value: string): string {
	if (!needsEnvQuotes(value)) return value;
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")
		.replace(/"/g, '\\"');
	return `"${escaped}"`;
}

export function envExampleTemplate(
	provider: InitProvider = "postgresql",
	databaseUrl?: string,
): string {
	const url = databaseUrl ?? defaultDatabaseUrl(provider);
	return `DATABASE_URL=${formatEnvValue(url)}
`;
}
