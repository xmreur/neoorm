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
	return `import { defineSchema, table, id, text, timestamp, fk } from "neoorm/schema";

export const schema = defineSchema({
  users: table("users", {
    id: id.primary(),
    email: text().notNull().unique(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow().updatedAt(),
  }),

  posts: table("posts", {
    id: id.primary(),
    authorId: fk("users.id", {
      as: "author",
      inverse: "posts",
      nullable: false,
    }),
    title: text().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow().updatedAt(),
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
