import { describe, expect, expectTypeOf, it } from "vitest";
import { emitModelsTs } from "../src/codegen/emit-models.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { defineSchema, table, timestamp, timestamps, uuid } from "../src/schema/index.js";
import type { CreateInput, InferSelectRow } from "../src/schema/types.js";

const schema = defineSchema({
	posts: table({
		id: uuid().primary(),
		...timestamps(),
		deletedAt: timestamp(),
	}),
});

type Tables = typeof schema._tables;
type PostCreate = CreateInput<Tables["posts"]["_columns"], Tables, "posts">;
type PostRow = InferSelectRow<Tables["posts"]["_columns"], Tables>;

describe("timestamp TypeScript types", () => {
	it("emits Date in generated models", () => {
		const models = emitModelsTs(schemaToManifest(schema));
		const post = models.match(/export type Post = \{[\s\S]*?\n\};/)?.[0];
		expect(post).toContain("createdAt: Date;");
		expect(post).toContain("deletedAt: Date | null;");
		expect(post).not.toContain("createdAt: string");
		expect(post).not.toContain("deletedAt: string");
	});

	it("types schema rows and inserts as Date", () => {
		expectTypeOf<PostRow["createdAt"]>().toEqualTypeOf<Date>();
		expectTypeOf<PostRow["deletedAt"]>().toEqualTypeOf<Date | null>();
		expectTypeOf<PostCreate["createdAt"]>().toEqualTypeOf<Date | undefined>();
		expectTypeOf<PostCreate["deletedAt"]>().toEqualTypeOf<
			Date | null | undefined
		>();

		const createdAt = new Date("2026-01-01T00:00:00.000Z");
		const data: PostCreate = { createdAt, deletedAt: null };
		void createdAt.toISOString();
		void data;
	});
});
