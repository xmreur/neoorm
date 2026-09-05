export function neoormConfigTemplate(
	schemaPath: string,
	outDir: string,
	provider: "postgresql" | "sqlite" = "postgresql",
	databaseUrl?: string,
): string {
	const url =
		databaseUrl ??
		(provider === "sqlite"
			? "./dev.db"
			: "postgresql://postgres:postgres@localhost:5432/myapp");
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
	provider: "postgresql" | "sqlite" = "postgresql",
	databaseUrl?: string,
): string {
	if (provider === "sqlite") {
		return `DATABASE_URL=${databaseUrl ?? "./dev.db"}
`;
	}
	return `DATABASE_URL=${databaseUrl ?? "postgresql://postgres:postgres@localhost:5432/myapp"}
`;
}
