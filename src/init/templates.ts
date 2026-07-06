export function neoormConfigTemplate(
	schemaPath: string,
	outDir: string,
): string {
	return `import { defineConfig } from "neoorm";

export default defineConfig({
  schema: "${schemaPath}",
  out: "${outDir}",
  datasource: {
    provider: "postgresql",
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/myapp",
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

export function envExampleTemplate(): string {
	return `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/myapp
`;
}
