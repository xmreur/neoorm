import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { validationFromManifest } from "../src/codegen/validation/from-manifest.js";
import type {
	ValidationField,
	ValidationType,
} from "../src/codegen/validation/types.js";
import {
	bool,
	citext,
	decimal,
	defineSchema,
	enumType,
	fk,
	id,
	int,
	jsonb,
	table,
	text,
	timestamp,
	timestamps,
	uuid,
} from "../src/schema/index.js";
import { defined } from "./helpers/manifest.js";

function fieldNamed(fields: ValidationField[], name: string): ValidationField {
	return defined(
		fields.find((field) => field.name === name),
		`field ${name}`,
	);
}

function tableNamed(
	ir: ReturnType<typeof validationFromManifest>,
	accessor: string,
) {
	return defined(
		ir.tables.find((table) => table.accessor === accessor),
		`table ${accessor}`,
	);
}

describe("validationFromManifest", () => {
	const schema = defineSchema({
		users: table({
			id: uuid().primary(),
			email: text().notNull().unique(),
			name: text(),
			password: text().notNull().hidden(),
			...timestamps(),
		}),
		posts: table({
			id: id(),
			authorId: fk("users").notNull(),
			title: text().notNull().minLength(1).maxLength(200),
			body: text().notNull(),
			published: bool().notNull().default(false),
			views: int().notNull().default(0).min(0),
			status: enumType(["draft", "published", "archived"])
				.notNull()
				.default("draft"),
			metadata: jsonb<Record<string, unknown>>(),
			price: decimal({ precision: 10, scale: 2 }).positive(),
			...timestamps(),
		}),
	});

	const ir = validationFromManifest(schemaToManifest(schema));

	it("omits hidden columns from select and requires them on create", () => {
		const users = tableNamed(ir, "users");
		expect(users.select.some((field) => field.name === "password")).toBe(
			false,
		);
		expect(fieldNamed(users.create, "password").optional).toBe(false);
		expect(fieldNamed(users.update, "password").optional).toBe(true);
	});

	it("omits primary keys and generated ids from create", () => {
		const users = tableNamed(ir, "users");
		const posts = tableNamed(ir, "posts");
		expect(users.create.some((field) => field.name === "id")).toBe(false);
		expect(posts.create.some((field) => field.name === "id")).toBe(false);
		expect(users.select.some((field) => field.name === "id")).toBe(true);
	});

	it("omits timestamps() fields from create and update, not select", () => {
		const users = tableNamed(ir, "users");
		expect(users.select.some((field) => field.name === "createdAt")).toBe(
			true,
		);
		expect(users.select.some((field) => field.name === "updatedAt")).toBe(
			true,
		);
		expect(users.create.some((field) => field.name === "createdAt")).toBe(
			false,
		);
		expect(users.create.some((field) => field.name === "updatedAt")).toBe(
			false,
		);
		expect(users.update.some((field) => field.name === "id")).toBe(false);
		expect(users.update.some((field) => field.name === "createdAt")).toBe(
			false,
		);
		expect(users.update.some((field) => field.name === "updatedAt")).toBe(
			false,
		);
	});

	it("omits timestamps() from create when the PK is id()", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				email: text().notNull().unique(),
				password: text().notNull().notEmpty().minLength(8).hidden(),
				...timestamps(),
			}),
		});
		const users = tableNamed(
			validationFromManifest(schemaToManifest(schema)),
			"users",
		);
		expect(users.create.map((field) => field.name)).toEqual([
			"email",
			"password",
		]);
		expect(users.update.map((field) => field.name)).toEqual([
			"email",
			"password",
		]);
		expect(users.select.map((field) => field.name)).toEqual([
			"id",
			"email",
			"createdAt",
			"updatedAt",
		]);
	});

	it("keeps timestamp columns that are not defaultNow or updatedAt", () => {
		const events = defineSchema({
			events: table({
				id: id(),
				startsAt: timestamp(),
			}),
		});
		const eventsIr = validationFromManifest(schemaToManifest(events));
		const eventsTable = tableNamed(eventsIr, "events");
		expect(fieldNamed(eventsTable.create, "startsAt").optional).toBe(true);
		expect(fieldNamed(eventsTable.update, "startsAt").optional).toBe(true);
	});

	it("marks defaulted and nullable create fields optional", () => {
		const users = tableNamed(ir, "users");
		const posts = tableNamed(ir, "posts");
		expect(fieldNamed(users.create, "email").optional).toBe(false);
		expect(fieldNamed(users.create, "name").optional).toBe(true);
		expect(fieldNamed(users.create, "name").nullable).toBe(true);
		expect(fieldNamed(posts.create, "published").optional).toBe(true);
		expect(fieldNamed(posts.create, "published").nullable).toBe(false);
	});

	it("maps email column names and .email() to string format email", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				email: text().notNull(),
				contactEmail: citext(),
				handle: text().notNull().email(),
				title: text().notNull(),
			}),
		});
		const users = tableNamed(
			validationFromManifest(schemaToManifest(schema)),
			"users",
		);
		expect(fieldNamed(users.create, "email").type).toEqual({
			kind: "string",
			format: "email",
		});
		expect(fieldNamed(users.create, "contactEmail").type).toEqual({
			kind: "string",
			format: "email",
		});
		expect(fieldNamed(users.create, "handle").type).toEqual({
			kind: "string",
			format: "email",
		});
		expect(fieldNamed(users.create, "title").type).toEqual({
			kind: "string",
		});
	});

	it("maps url column names and .url() to string format url", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				url: text().notNull(),
				avatarUrl: text(),
				website: text().notNull().url(),
				title: text().notNull(),
			}),
		});
		const users = tableNamed(
			validationFromManifest(schemaToManifest(schema)),
			"users",
		);
		expect(fieldNamed(users.create, "url").type).toEqual({
			kind: "string",
			format: "url",
		});
		expect(fieldNamed(users.create, "avatarUrl").type).toEqual({
			kind: "string",
			format: "url",
		});
		expect(fieldNamed(users.create, "website").type).toEqual({
			kind: "string",
			format: "url",
		});
		expect(fieldNamed(users.create, "title").type).toEqual({
			kind: "string",
		});
	});

	it("does not treat uuid columns named email as email format", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				email: uuid().notNull().unique(),
			}),
			posts: table({
				id: id(),
				authorEmail: fk("users.email").notNull(),
			}),
		});
		const users = tableNamed(
			validationFromManifest(schemaToManifest(schema)),
			"users",
		);
		const posts = tableNamed(
			validationFromManifest(schemaToManifest(schema)),
			"posts",
		);
		expect(fieldNamed(users.create, "email").type).toEqual({
			kind: "string",
			format: "uuid",
		});
		expect(fieldNamed(posts.create, "authorEmail").type).toEqual({
			kind: "string",
			format: "uuid",
		});
	});

	it("uses the referenced PK validation type for foreign keys", () => {
		const posts = tableNamed(ir, "posts");
		expect(fieldNamed(posts.select, "authorId").type).toEqual({
			kind: "string",
			format: "uuid",
		});
		expect(fieldNamed(posts.create, "authorId").optional).toBe(false);
	});

	it("maps json columns to unknown and does not emit relation keys", () => {
		const posts = tableNamed(ir, "posts");
		expect(fieldNamed(posts.select, "metadata").type).toEqual({
			kind: "unknown",
		});
		expect(posts.select.some((field) => field.name === "tags")).toBe(false);
		expect(posts.create.some((field) => field.name === "author")).toBe(
			false,
		);
	});

	it("copies typed constraints onto fields", () => {
		const posts = tableNamed(ir, "posts");
		expect(fieldNamed(posts.select, "title").constraints).toEqual({
			minLength: 1,
			maxLength: 200,
		});
		expect(fieldNamed(posts.select, "views").constraints).toEqual({
			min: 0,
		});
		expect(fieldNamed(posts.select, "price").constraints).toEqual({
			positive: true,
		});
	});

	it("hoists unnamed enums by value list", () => {
		const posts = tableNamed(ir, "posts");
		const statusType = fieldNamed(posts.select, "status")
			.type as ValidationType;
		expect(statusType.kind).toBe("enum");
		if (statusType.kind !== "enum") {
			return;
		}
		expect(statusType.name).toBe("PostStatus");
		expect(statusType.values).toEqual(["draft", "published", "archived"]);
		expect(ir.enums).toContainEqual({
			name: "PostStatus",
			values: ["draft", "published", "archived"],
		});
	});

	it("hoists named enums by typeOptions.name", () => {
		const named = defineSchema({
			items: table({
				id: id(),
				itemKind: enumType(["a", "b"], { name: "item_kind" }).notNull(),
			}),
		});
		const namedIr = validationFromManifest(schemaToManifest(named));
		expect(namedIr.enums).toContainEqual({
			name: "ItemKind",
			values: ["a", "b"],
		});
	});

	it("falls back to unknown when a column kind has no columnValidation hook", () => {
		const ir = validationFromManifest({
			version: 1,
			tables: {
				widgets: {
					accessor: "widgets",
					sqlName: "widgets",
					columns: [
						{
							tsName: "payload",
							sqlName: "payload",
							kind: "custom_unregistered",
							nullable: false,
							unique: false,
							primary: false,
							defaultNow: false,
						},
					],
					relations: [],
					indexes: [],
					primaryKey: [],
				},
			},
			manyToMany: [],
		});
		expect(
			fieldNamed(tableNamed(ir, "widgets").select, "payload").type,
		).toEqual({ kind: "unknown" });
	});
});
