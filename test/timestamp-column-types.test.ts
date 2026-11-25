import { describe, expect, expectTypeOf, it } from "vitest";
import { emitModelsTs } from "../src/codegen/emit-models.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { emitElysiaTs } from "../src/codegen/validation/emit-elysia.js";
import { emitTypeboxTs } from "../src/codegen/validation/emit-typebox.js";
import { emitZodTs } from "../src/codegen/validation/emit-zod.js";
import { validationFromManifest } from "../src/codegen/validation/from-manifest.js";
import {
	defineSchema,
	table,
	text,
	timestamp,
	timestamps,
	uuid,
} from "../src/schema/index.js";
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
		const post = models.match(/export interface Post \{[\s\S]*?\n\}/)?.[0];
		expect(post).toContain("createdAt: Date;");
		expect(post).toContain("deletedAt: Date | null;");
		expect(post).not.toContain("createdAt: string");
		expect(post).not.toContain("deletedAt: string");
	});

	it("types schema rows and inserts as Date", () => {
		expectTypeOf<PostRow["createdAt"]>().toEqualTypeOf<Date>();
		expectTypeOf<PostRow["deletedAt"]>().toEqualTypeOf<Date | null>();
		expectTypeOf<PostCreate["createdAt"]>().toEqualTypeOf<
			Date | undefined
		>();
		expectTypeOf<PostCreate["deletedAt"]>().toEqualTypeOf<
			Date | null | undefined
		>();

		const createdAt = new Date("2026-01-01T00:00:00.000Z");
		const data: PostCreate = { createdAt, deletedAt: null };
		void createdAt.toISOString();
		void data;
	});

	it("treats timestamp().primary() as not null", () => {
		expect(timestamp().primary()._meta).toMatchObject({
			primary: true,
			nullable: false,
		});
		expect(text().primary()._meta.nullable).toBe(false);

		const eventSchema = defineSchema({
			events: table({
				at: timestamp().primary(),
				deletedAt: timestamp(),
			}),
		});
		type EventRow = InferSelectRow<
			(typeof eventSchema._tables)["events"]["_columns"]
		>;
		expectTypeOf<EventRow["at"]>().toEqualTypeOf<Date>();
		expectTypeOf<EventRow["deletedAt"]>().toEqualTypeOf<Date | null>();

		const manifest = schemaToManifest(eventSchema);
		const columns = manifest.tables.events?.columns;
		expect(columns?.find((col) => col.tsName === "at")?.nullable).toBe(
			false,
		);
		expect(
			columns?.find((col) => col.tsName === "deletedAt")?.nullable,
		).toBe(true);

		const models = emitModelsTs(manifest);
		expect(models).toContain("at: Date;");
		expect(models).toContain("deletedAt: Date | null;");

		const ir = validationFromManifest(manifest);
		const zod = emitZodTs(ir);
		const typebox = emitTypeboxTs(ir);
		const elysia = emitElysiaTs(ir);
		expect(zod).toContain("at: dateValue,");
		expect(zod).toContain("deletedAt: dateValue.nullable(),");
		expect(typebox).toContain("at: dateValue,");
		expect(typebox).toContain(
			"deletedAt: Type.Union([dateValue, Type.Null()]),",
		);
		expect(elysia).toContain("at: t.Date(),");
		expect(elysia).toContain("deletedAt: t.Nullable(t.Date()),");
	});
});
