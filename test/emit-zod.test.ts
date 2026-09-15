import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { emitZodTs } from "../src/codegen/validation/emit-zod.js";
import { validationFromManifest } from "../src/codegen/validation/from-manifest.js";
import type { ValidationIR } from "../src/codegen/validation/types.js";
import type { SchemaDef } from "../src/schema/define-schema.js";
import {
	bigint,
	bytea,
	decimal,
	defineSchema,
	enumType,
	fk,
	id,
	int,
	jsonb,
	many,
	table,
	text,
	timestamp,
	timestamps,
	uuid,
} from "../src/schema/index.js";
import type { TableDef } from "../src/schema/table.js";

function emitFromSchema<T extends Record<string, TableDef>>(
	schema: SchemaDef<T>,
): string {
	return emitZodTs(validationFromManifest(schemaToManifest(schema)));
}

describe("emitZodTs", () => {
	it("prints select/create/update schemas from IR only", () => {
		const source = emitFromSchema(
			defineSchema({
				users: table({
					id: uuid().primary(),
					email: text().notNull(),
					name: text(),
					password: text().notNull().hidden(),
					...timestamps(),
				}),
			}),
		);

		expect(source).toContain('import { z } from "zod";');
		expect(source).toContain("export const UserSchema = z.object({");
		expect(source).toContain("id: z.uuid()");
		expect(source).toContain("email: z.email()");
		expect(source).toContain("name: z.string().nullable()");
		const selectSource = source.slice(
			source.indexOf("export const UserSchema"),
			source.indexOf("export const UserCreateSchema"),
		);
		expect(selectSource).not.toContain("password");
		expect(source).toContain("password: z.string()");
		expect(source).toContain("password: z.string().optional()");
		expect(source).toContain("createdAt: dateValue");
		expect(source).toContain("updatedAt: dateValue");
		expect(source).toContain(
			".union([z.date(), z.iso.datetime({ offset: true })])",
		);
		expect(source).toContain(
			"export type UserSelect = z.infer<typeof UserSchema>;",
		);
		expect(source).toContain(
			"export type UserCreate = z.infer<typeof UserCreateSchema>;",
		);
		expect(source).toContain(
			"export type UserUpdate = z.infer<typeof UserUpdateSchema>;",
		);
		expect(source).toContain("export const UserCreateSchema = z.object({");
		expect(source).toContain("email: z.email()");
		expect(source).toContain("name: z.string().nullable().optional()");
		expect(source).not.toMatch(/UserCreateSchema[\s\S]*\bid: /);
		expect(source).not.toMatch(/UserCreateSchema[\s\S]*createdAt/);
		expect(source).not.toMatch(/UserCreateSchema[\s\S]*updatedAt/);
		expect(source).toContain("export const UserUpdateSchema = z.object({");
		expect(source).toContain("email: z.email().optional()");
		expect(source).not.toMatch(/UserUpdateSchema[\s\S]*createdAt/);
		expect(source).not.toMatch(/UserUpdateSchema[\s\S]*updatedAt/);
		expect(source).toContain(
			"users: { select: UserSchema, create: UserCreateSchema, update: UserUpdateSchema }",
		);
	});

	it("emits named enums, uuid FKs, json unknown, and decimal refine", () => {
		const source = emitFromSchema(
			defineSchema({
				users: table({
					id: uuid().primary(),
				}),
				posts: table({
					id: id(),
					authorId: fk("users").notNull(),
					status: enumType(["draft", "published"]).notNull(),
					metadata: jsonb(),
					price: decimal().positive(),
				}),
			}),
		);

		expect(source).toContain(
			'export const PostStatusSchema = z.enum(["draft","published"]);',
		);
		expect(source).toContain(
			"export type PostStatus = z.infer<typeof PostStatusSchema>;",
		);
		expect(source).toContain("status: PostStatusSchema");
		expect(source).toContain("authorId: z.uuid()");
		expect(source).toContain(
			"metadata: z.record(z.string(), z.unknown()).nullable()",
		);
		expect(source).toContain(
			"price: z.string().refine((value) => Number(value) > 0).nullable()",
		);
	});

	it("maps string length, int min, bigint min, and Buffer custom", () => {
		const source = emitFromSchema(
			defineSchema({
				items: table({
					id: id(),
					title: text().notNull().minLength(1).maxLength(20),
					count: int().notNull().min(0).max(10),
					amount: bigint().notNull().min(0n),
					blob: bytea(),
				}),
			}),
		);

		expect(source).toContain("title: z.string().min(1).max(20)");
		expect(source).toContain("count: z.number().int().min(0).max(10)");
		expect(source).toContain('amount: z.bigint().min(BigInt("0"))');
		expect(source).toContain(
			"blob: z.custom<Buffer>((v) => Buffer.isBuffer(v)).nullable()",
		);
	});

	it("emits z.email() for email names, *Email names, and .email()", () => {
		const source = emitFromSchema(
			defineSchema({
				users: table({
					id: id(),
					email: text({ maxLength: 255 }).notNull(),
					contactEmail: text(),
					handle: text().notNull().email(),
					title: text().notNull(),
				}),
			}),
		);

		expect(source).toContain("email: z.email().max(255)");
		expect(source).toContain("contactEmail: z.email().nullable()");
		expect(source).toContain("handle: z.email()");
		expect(source).toContain("title: z.string()");
	});

	it("emits z.url() for url names, *Url names, and .url()", () => {
		const source = emitFromSchema(
			defineSchema({
				users: table({
					id: id(),
					url: text().notNull(),
					avatarUrl: text(),
					website: text().notNull().url(),
					title: text().notNull(),
				}),
			}),
		);

		expect(source).toContain("url: z.url()");
		expect(source).toContain("avatarUrl: z.url().nullable()");
		expect(source).toContain("website: z.url()");
		expect(source).toContain("title: z.string()");
	});

	it("does not inspect ManifestColumn kinds — unknown IR prints z.unknown()", () => {
		const ir: ValidationIR = {
			enums: [],
			tables: [
				{
					accessor: "widgets",
					modelName: "Widget",
					select: [
						{
							name: "payload",
							type: { kind: "unknown" },
							nullable: false,
							optional: false,
						},
					],
					create: [
						{
							name: "payload",
							type: { kind: "unknown" },
							nullable: false,
							optional: false,
						},
					],
					update: [
						{
							name: "payload",
							type: { kind: "unknown" },
							nullable: false,
							optional: true,
						},
					],
				},
			],
		};
		const source = emitZodTs(ir);
		expect(source).toContain("payload: z.unknown()");
		expect(source).toContain("payload: z.unknown().optional()");
		expect(source).not.toContain("dateValue");
	});

	it("parses Date instances and ISO strings into Date", async () => {
		const source = emitFromSchema(
			defineSchema({
				events: table({
					id: uuid().primary(),
					startsAt: timestamp().notNull(),
				}),
			}),
		);
		const tmpRoot = join(import.meta.dirname, ".tmp");
		await mkdir(tmpRoot, { recursive: true });
		const dir = await mkdtemp(join(tmpRoot, "zod-date-"));
		const file = join(dir, "zod.ts");
		try {
			await writeFile(file, source, "utf-8");
			const mod = (await import(pathToFileURL(file).href)) as {
				EventSchema: {
					parse: (value: unknown) => { startsAt: Date };
				};
			};
			const fromIso = mod.EventSchema.parse({
				id: "11111111-1111-4111-8111-111111111111",
				startsAt: "2020-01-01T00:00:00.000Z",
			});
			expect(fromIso.startsAt).toBeInstanceOf(Date);
			expect(fromIso.startsAt.toISOString()).toBe(
				"2020-01-01T00:00:00.000Z",
			);
			const instant = new Date("2021-06-15T12:30:00.000Z");
			const fromDate = mod.EventSchema.parse({
				id: "11111111-1111-4111-8111-111111111111",
				startsAt: instant,
			});
			expect(fromDate.startsAt).toBeInstanceOf(Date);
			expect(fromDate.startsAt.toISOString()).toBe(instant.toISOString());
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("emits junction LinkCreateSchema and skips empty UpdateSchema", () => {
		const source = emitFromSchema(
			defineSchema({
				posts: table({
					id: id(),
					tags: many("tags"),
				}),
				tags: table({
					id: id(),
					slug: text().notNull(),
				}),
			}),
		);

		expect(source).toContain(
			"// Many-to-many junction for posts.tags ↔ tags.posts.",
		);
		expect(source).toContain("tags: { connect: [{ id }] }");
		expect(source).toContain(
			"export const PostsTagLinkCreateSchema = z.object({",
		);
		expect(source).toContain("postId: z.string()");
		expect(source).toContain("tagId: z.string()");
		expect(source).toContain(
			"export const PostsTagCreateSchema = PostsTagLinkCreateSchema;",
		);
		expect(source).toContain(
			"export type PostsTagLinkCreate = z.infer<typeof PostsTagLinkCreateSchema>;",
		);
		expect(source).toContain(
			"export type PostsTagCreate = z.infer<typeof PostsTagCreateSchema>;",
		);
		expect(source).not.toContain("PostsTagUpdateSchema");
		expect(source).toContain(
			"// No scalar updates on junction rows — use nested relation writes on posts.tags",
		);
		expect(source).toContain(
			"posts_tags: { select: PostsTagSchema, create: PostsTagCreateSchema }",
		);
		expect(source).not.toMatch(
			/posts_tags: \{ select: PostsTagSchema, create: PostsTagCreateSchema, update:/,
		);
	});

	it("emits junction UpdateSchema when the through table has extra columns", () => {
		const source = emitFromSchema(
			defineSchema({
				posts: table({
					id: id(),
					tags: many("tags", { through: "posts_tags" }),
				}),
				tags: table({ id: id() }),
				posts_tags: table({
					postId: fk("posts").primary(),
					tagId: fk("tags").primary(),
					priority: int().notNull().default(0),
				}),
			}),
		);

		expect(source).toContain(
			"export const PostsTagLinkCreateSchema = z.object({",
		);
		expect(source).toContain("postId: z.string()");
		expect(source).toContain("tagId: z.string()");
		expect(source).toContain("priority: z.number().int().optional()");
		expect(source).toContain(
			"export const PostsTagUpdateSchema = z.object({",
		);
		expect(source).toContain("priority: z.number().int().optional()");
		expect(source).not.toMatch(/PostsTagUpdateSchema[\s\S]*postId:/);
		expect(source).toContain(
			"posts_tags: { select: PostsTagSchema, create: PostsTagCreateSchema, update: PostsTagUpdateSchema }",
		);
	});
});
