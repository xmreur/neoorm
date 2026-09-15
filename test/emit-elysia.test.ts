import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { emitElysiaTs } from "../src/codegen/validation/emit-elysia.js";
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
	timestamps,
	uuid,
} from "../src/schema/index.js";
import type { TableDef } from "../src/schema/table.js";

function emitFromSchema<T extends Record<string, TableDef>>(
	schema: SchemaDef<T>,
): string {
	return emitElysiaTs(validationFromManifest(schemaToManifest(schema)));
}

describe("emitElysiaTs", () => {
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

		expect(source).toContain('import { t } from "elysia";');
		expect(source).not.toContain("typebox");
		expect(source).toContain("export const UserSchema = t.Object({");
		expect(source).toContain('id: t.String({ format: "uuid" })');
		expect(source).toContain('email: t.String({ format: "email" })');
		expect(source).toContain("name: t.Nullable(t.String())");
		const selectSource = source.slice(
			source.indexOf("export const UserSchema"),
			source.indexOf("export const UserCreateSchema"),
		);
		expect(selectSource).not.toContain("password");
		expect(source).toContain("password: t.String()");
		expect(source).toContain("password: t.Optional(t.String())");
		expect(source).toContain("createdAt: t.Date()");
		expect(source).toContain("updatedAt: t.Date()");
		expect(source).toContain(
			"export type UserSelect = typeof UserSchema.static;",
		);
		expect(source).toContain(
			"export type UserCreate = typeof UserCreateSchema.static;",
		);
		expect(source).toContain(
			"export type UserUpdate = typeof UserUpdateSchema.static;",
		);
		expect(source).toContain("export const UserCreateSchema = t.Object({");
		expect(source).toContain("name: t.Optional(t.Nullable(t.String()))");
		expect(source).not.toMatch(/UserCreateSchema[\s\S]*\bid: /);
		expect(source).not.toMatch(/UserCreateSchema[\s\S]*createdAt/);
		expect(source).not.toMatch(/UserCreateSchema[\s\S]*updatedAt/);
		expect(source).toContain("export const UserUpdateSchema = t.Object({");
		expect(source).toContain(
			'email: t.Optional(t.String({ format: "email" }))',
		);
		expect(source).not.toMatch(/UserUpdateSchema[\s\S]*createdAt/);
		expect(source).not.toMatch(/UserUpdateSchema[\s\S]*updatedAt/);
		expect(source).toContain(
			"users: { select: UserSchema, create: UserCreateSchema, update: UserUpdateSchema }",
		);
	});

	it("emits named enums, uuid FKs, json unknown, and decimal transform", () => {
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
			'export const PostStatusSchema = t.UnionEnum(["draft","published"]);',
		);
		expect(source).toContain(
			"export type PostStatus = typeof PostStatusSchema.static;",
		);
		expect(source).toContain("status: PostStatusSchema");
		expect(source).toContain('authorId: t.String({ format: "uuid" })');
		expect(source).toContain(
			"metadata: t.Nullable(t.Record(t.String(), t.Unknown()))",
		);
		expect(source).toContain(
			'price: t.Nullable(t.Transform(t.String()).Decode((value) => { if (!(Number(value) > 0)) throw new Error("Invalid decimal"); return value; }).Encode((value) => value))',
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

		expect(source).toContain(
			"title: t.String({ minLength: 1, maxLength: 20 })",
		);
		expect(source).toContain(
			"count: t.Integer({ minimum: 0, maximum: 10 })",
		);
		expect(source).toContain('amount: t.BigInt({ minimum: BigInt("0") })');
		expect(source).toContain(
			'const bufferValue = t.Transform(t.Any()).Decode((value) => { if (!Buffer.isBuffer(value)) throw new Error("Expected Buffer"); return value; }).Encode((value) => value);',
		);
		expect(source).toContain("blob: t.Nullable(bufferValue)");
	});

	it("emits email format for email names, *Email names, and .email()", () => {
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

		expect(source).toContain(
			'email: t.String({ format: "email", maxLength: 255 })',
		);
		expect(source).toContain(
			'contactEmail: t.Nullable(t.String({ format: "email" }))',
		);
		expect(source).toContain('handle: t.String({ format: "email" })');
		expect(source).toContain("title: t.String()");
	});

	it("emits uri format for url names, *Url names, and .url()", () => {
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

		expect(source).toContain('url: t.String({ format: "uri" })');
		expect(source).toContain(
			'avatarUrl: t.Nullable(t.String({ format: "uri" }))',
		);
		expect(source).toContain('website: t.String({ format: "uri" })');
		expect(source).toContain("title: t.String()");
	});

	it("does not inspect ManifestColumn kinds — unknown IR prints t.Unknown()", () => {
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
		const source = emitElysiaTs(ir);
		expect(source).toContain("payload: t.Unknown()");
		expect(source).toContain("payload: t.Optional(t.Unknown())");
		expect(source).not.toContain("t.Date()");
		expect(source).not.toContain("bufferValue");
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
			"export const PostsTagLinkCreateSchema = t.Object({",
		);
		expect(source).toContain("postId: t.String()");
		expect(source).toContain("tagId: t.String()");
		expect(source).toContain(
			"export const PostsTagCreateSchema = PostsTagLinkCreateSchema;",
		);
		expect(source).toContain(
			"export type PostsTagLinkCreate = typeof PostsTagLinkCreateSchema.static;",
		);
		expect(source).toContain(
			"export type PostsTagCreate = typeof PostsTagCreateSchema.static;",
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
			"export const PostsTagLinkCreateSchema = t.Object({",
		);
		expect(source).toContain("postId: t.String()");
		expect(source).toContain("tagId: t.String()");
		expect(source).toContain("priority: t.Optional(t.Integer())");
		expect(source).toContain(
			"export const PostsTagUpdateSchema = t.Object({",
		);
		expect(source).toContain("priority: t.Optional(t.Integer())");
		expect(source).not.toMatch(/PostsTagUpdateSchema[\s\S]*postId:/);
		expect(source).toContain(
			"posts_tags: { select: PostsTagSchema, create: PostsTagCreateSchema, update: PostsTagUpdateSchema }",
		);
	});
});
