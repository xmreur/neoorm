import { beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import type { Executor } from "../src/runtime/executor.js";
import { createManyRecords, runCreate } from "../src/runtime/query/create.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import {
	applyToOnePreWrites,
	executeRelationWrites,
	hasPostRelationWrites,
	splitScalarsAndRelationWrites,
} from "../src/runtime/query/relation-writes.js";
import {
	defineSchema,
	fk,
	foreignKey,
	id,
	int,
	primaryKey,
	table,
	text,
	uuid,
} from "../src/schema/index.js";
import { manifestTable } from "./helpers/manifest.js";

function createMockExecutor(): Executor & {
	queries: { sql: string; params: unknown[] }[];
} {
	const queries: { sql: string; params: unknown[] }[] = [];
	return {
		queries,
		inTransaction: false,
		query: vi.fn(async (sql: string, params?: unknown[]) => {
			queries.push({ sql, params: params ?? [] });
			return [];
		}),
		queryOne: vi.fn(
			async <T = Record<string, unknown>>(
				sql: string,
				params?: unknown[],
			) => {
				queries.push({ sql, params: params ?? [] });
				if (sql.includes("INSERT INTO")) {
					return { id: "new_id" } as T;
				}
				return null;
			},
		) as Executor["queryOne"],
		execute: vi.fn(async (sql: string, params?: unknown[]) => {
			queries.push({ sql, params: params ?? [] });
			return { rows: [], rowCount: 0 };
		}) as Executor["execute"],
		transaction: vi.fn(async (fn) => fn(createMockExecutor())),
	};
}

describe("relation-writes", () => {
	let manifest: ReturnType<typeof schemaToManifest>;
	let runtime: QueryRuntime;

	beforeAll(() => {
		manifest = schemaToManifest(schema);
		runtime = { manifest };
	});

	it("manifest includes M2M tags relation on posts", () => {
		const names = manifestTable(manifest, "posts").relations.map(
			(r) => r.name,
		);
		expect(names).toContain("tags");
		expect(names).toContain("comments");
	});

	it("splitScalarsAndRelationWrites separates scalar and relation fields", () => {
		const table = manifestTable(manifest, "posts");
		const { scalarData, relationWrites } = splitScalarsAndRelationWrites(
			manifest,
			"posts",
			table,
			{
				title: "Hello",
				author: { connect: { id: "user_1" } },
				tags: { connect: [{ id: "tag_1" }] },
			},
		);

		expect(scalarData).toEqual({ title: "Hello" });
		expect(relationWrites).toHaveLength(2);
		expect(relationWrites[0]?.relationName).toBe("author");
		expect(relationWrites[1]?.relationName).toBe("tags");
	});

	it("splitScalarsAndRelationWrites recognizes nested delete", () => {
		const table = manifestTable(manifest, "posts");
		const { scalarData, relationWrites } = splitScalarsAndRelationWrites(
			manifest,
			"posts",
			table,
			{
				comments: { delete: [{ id: "comment_1" }] },
			},
		);

		expect(scalarData).toEqual({});
		expect(relationWrites).toHaveLength(1);
		expect(relationWrites[0]?.relationName).toBe("comments");
		expect(relationWrites[0]?.value).toEqual({
			delete: [{ id: "comment_1" }],
		});
	});

	it("rejects unknown keys in create data", () => {
		const table = manifestTable(manifest, "users");
		expect(() =>
			splitScalarsAndRelationWrites(manifest, "users", table, {
				emial: "a@b.com",
			}),
		).toThrow(/Unknown column "emial" in data/);
		try {
			splitScalarsAndRelationWrites(manifest, "users", table, {
				emial: "a@b.com",
			});
		} catch (err) {
			expect((err as { code: string }).code).toBe("unknown_column");
		}
	});

	it("rejects a relation field that is not a nested write", () => {
		const table = manifestTable(manifest, "posts");
		expect(() =>
			splitScalarsAndRelationWrites(manifest, "posts", table, {
				title: "Hello",
				author: "user_1",
			}),
		).toThrow(/Relation "author" requires a nested write object/);
	});

	it("rejects unknown keys in createMany", async () => {
		await expect(
			createManyRecords(createMockExecutor(), runtime, "users", {
				data: [{ email: "a@b.com", emial: "typo" }],
			}),
		).rejects.toThrow(/Unknown column "emial" in data/);
	});

	it("hasPostRelationWrites is true for delete-only payload", () => {
		const table = manifestTable(manifest, "posts");
		const { relationWrites } = splitScalarsAndRelationWrites(
			manifest,
			"posts",
			table,
			{ comments: { delete: [{ id: "comment_1" }] } },
		);

		expect(
			hasPostRelationWrites(table, manifest, "posts", relationWrites),
		).toBe(true);
	});

	it("applyToOnePreWrites sets FK from connect", async () => {
		const executor = createMockExecutor();
		const table = manifestTable(manifest, "posts");
		const scalarData: Record<string, unknown> = { title: "T" };

		await applyToOnePreWrites(
			executor,
			runtime,
			table,
			scalarData,
			[{ relationName: "author", value: { connect: { id: "user_1" } } }],
			runCreate,
		);

		expect(scalarData.authorId).toBe("user_1");
	});

	it("applyToOnePreWrites rejects disconnect on non-nullable FK", async () => {
		const executor = createMockExecutor();
		const table = manifestTable(manifest, "posts");
		const scalarData: Record<string, unknown> = {};

		await expect(
			applyToOnePreWrites(
				executor,
				runtime,
				table,
				scalarData,
				[{ relationName: "author", value: { disconnect: true } }],
				runCreate,
			),
		).rejects.toThrow(/not nullable/);
	});

	it("executeRelationWrites connects inverse many children", async () => {
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[
				{
					relationName: "comments",
					value: { connect: [{ id: "comment_1" }] },
				},
			],
			runCreate,
		);

		const update = executor.queries.find((q) => q.sql.includes("UPDATE"));
		expect(update?.sql).toContain("comments");
		expect(update?.params).toEqual(["post_1", "comment_1"]);
	});

	it("executeRelationWrites deletes inverse many children scoped to parent", async () => {
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[
				{
					relationName: "comments",
					value: { delete: [{ id: "comment_1" }] },
				},
			],
			runCreate,
		);

		const deleteQuery = executor.queries.find((q) =>
			q.sql.startsWith("DELETE"),
		);
		expect(deleteQuery?.sql).toContain("comments");
		expect(deleteQuery?.sql).toContain("post_id");
		expect(deleteQuery?.params).toEqual(["post_1", "comment_1"]);
	});

	it("executeRelationWrites deletes all inverse many children when delete is true", async () => {
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[{ relationName: "comments", value: { delete: true } }],
			runCreate,
		);

		const deleteQuery = executor.queries.find((q) =>
			q.sql.startsWith("DELETE"),
		);
		expect(deleteQuery?.sql).toContain("comments");
		expect(deleteQuery?.sql).toContain("post_id");
		expect(deleteQuery?.params).toEqual(["post_1"]);
	});

	it("executeRelationWrites deletes M2M related rows after junction unlink", async () => {
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[{ relationName: "tags", value: { delete: [{ id: "tag_1" }] } }],
			runCreate,
		);

		const deleteQueries = executor.queries.filter((q) =>
			q.sql.startsWith("DELETE"),
		);
		expect(deleteQueries).toHaveLength(2);
		expect(deleteQueries[0]?.sql).toContain("posts_tags");
		expect(deleteQueries[1]?.sql).toContain("tags");
		expect(deleteQueries[1]?.params).toEqual(["tag_1"]);
	});

	it("executeRelationWrites sets M2M links", async () => {
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[
				{
					relationName: "tags",
					value: { set: [{ id: "tag_1" }, { id: "tag_2" }] },
				},
			],
			runCreate,
		);

		const deleteQuery = executor.queries.find((q) =>
			q.sql.startsWith("DELETE"),
		);
		expect(deleteQuery?.sql).toContain("posts_tags");
		const inserts = executor.queries.filter((q) =>
			q.sql.includes("INSERT"),
		);
		expect(inserts).toHaveLength(1);
		expect(inserts[0]?.sql).toContain("ON CONFLICT DO NOTHING");
		expect(inserts[0]?.sql).toContain("VALUES ($1, $2), ($3, $4)");
		expect(inserts[0]?.params).toEqual([
			"post_1",
			"tag_1",
			"post_1",
			"tag_2",
		]);
	});

	it("executeRelationWrites connects M2M links in one insert", async () => {
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[
				{
					relationName: "tags",
					value: {
						connect: [
							{ id: "tag_1" },
							{ id: "tag_2" },
							{ id: "tag_1" },
						],
					},
				},
			],
			runCreate,
		);

		expect(executor.queries.some((q) => q.sql.startsWith("SELECT"))).toBe(
			false,
		);
		const inserts = executor.queries.filter((q) =>
			q.sql.includes("INSERT"),
		);
		expect(inserts).toHaveLength(1);
		expect(inserts[0]?.sql).toContain("ON CONFLICT DO NOTHING");
		expect(inserts[0]?.params).toEqual([
			"post_1",
			"tag_1",
			"post_1",
			"tag_2",
		]);
	});

	it("executeRelationWrites creates nested inverse rows", async () => {
		const executor = createMockExecutor();
		const { queries } = executor;
		const insertSpy = vi.fn(
			async <T = Record<string, unknown>>(
				sql: string,
				params?: unknown[],
			) => {
				queries.push({ sql, params: params ?? [] });
				return { id: "comment_new" } as T;
			},
		);
		executor.queryOne = insertSpy as Executor["queryOne"];

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[
				{
					relationName: "comments",
					value: {
						create: [
							{
								body: "Nested",
								author: { connect: { id: "user_1" } },
							},
						],
					},
				},
			],
			runCreate,
		);

		expect(insertSpy).toHaveBeenCalled();
		const insertQuery = executor.queries.find((q) =>
			q.sql.includes("INSERT INTO"),
		);
		expect(insertQuery?.params).toContain("post_1");
	});
});

describe("relation connect uses the target scalar PK tsName", () => {
	const customPkSchema = defineSchema({
		accounts: table({
			userId: uuid().primary(),
			email: text().notNull(),
		}),
		notes: table({
			id: id(),
			accountId: fk("accounts").notNull().as("account").inverse("notes"),
			body: text().notNull(),
		}),
	});

	it("sets the FK from connect using a non-id primary key", async () => {
		const manifest = schemaToManifest(customPkSchema);
		const runtime: QueryRuntime = { manifest };
		const table = manifestTable(manifest, "notes");
		const scalarData: Record<string, unknown> = { body: "hello" };

		await applyToOnePreWrites(
			createMockExecutor(),
			runtime,
			table,
			scalarData,
			[
				{
					relationName: "account",
					value: { connect: { userId: "acct_1" } },
				},
			],
			runCreate,
		);

		expect(scalarData.accountId).toBe("acct_1");
	});

	it("rejects connect that uses id when the target PK is not id", async () => {
		const manifest = schemaToManifest(customPkSchema);
		const runtime: QueryRuntime = { manifest };
		const table = manifestTable(manifest, "notes");

		await expect(
			applyToOnePreWrites(
				createMockExecutor(),
				runtime,
				table,
				{ body: "hello" },
				[
					{
						relationName: "account",
						value: { connect: { id: "acct_1" } },
					},
				],
				runCreate,
			),
		).rejects.toThrow(/userId/);
	});

	it("connects a composite primary key using the referenced column", async () => {
		const manifest = schemaToManifest(customPkSchema);
		const accounts = manifestTable(manifest, "accounts");
		accounts.primaryKey = ["user_id", "email"];
		const runtime: QueryRuntime = { manifest };
		const table = manifestTable(manifest, "notes");
		const scalarData: Record<string, unknown> = { body: "hello" };

		await applyToOnePreWrites(
			createMockExecutor(),
			runtime,
			table,
			scalarData,
			[
				{
					relationName: "account",
					value: {
						connect: { userId: "acct_1", email: "a@b.c" },
					},
				},
			],
			runCreate,
		);

		expect(scalarData.accountId).toBe("acct_1");
	});

	it("rejects composite connect missing a PK column", async () => {
		const manifest = schemaToManifest(customPkSchema);
		const accounts = manifestTable(manifest, "accounts");
		accounts.primaryKey = ["user_id", "email"];
		const runtime: QueryRuntime = { manifest };
		const table = manifestTable(manifest, "notes");

		await expect(
			applyToOnePreWrites(
				createMockExecutor(),
				runtime,
				table,
				{ body: "hello" },
				[
					{
						relationName: "account",
						value: { connect: { userId: "acct_1" } },
					},
				],
				runCreate,
			),
		).rejects.toThrow(/email/);
	});

	it("sets a to-one FK from connectOrCreate", async () => {
		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = { manifest };
		const table = manifestTable(manifest, "posts");
		const scalarData: Record<string, unknown> = {
			title: "Hello",
			body: "World",
		};

		await applyToOnePreWrites(
			createMockExecutor(),
			runtime,
			table,
			scalarData,
			[
				{
					relationName: "author",
					value: {
						connectOrCreate: {
							where: { email: "a@b.c" },
							create: {
								email: "a@b.c",
								password: "secret",
							},
						},
					},
				},
			],
			runCreate,
		);

		expect(scalarData.authorId).toBe("new_id");
	});

	it("rejects mixing to-one connectOrCreate with connect", async () => {
		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = { manifest };
		const table = manifestTable(manifest, "posts");

		await expect(
			applyToOnePreWrites(
				createMockExecutor(),
				runtime,
				table,
				{ title: "Hello", body: "World" },
				[
					{
						relationName: "author",
						value: {
							connectOrCreate: {
								where: { email: "a@b.c" },
								create: {
									email: "a@b.c",
									password: "secret",
								},
							},
							connect: { id: "user_1" },
						},
					},
				],
				runCreate,
			),
		).rejects.toThrow(/cannot mix connectOrCreate/);
	});
});

describe("composite PK inverse connect", () => {
	const lineSchema = defineSchema({
		orders: table({
			id: id(),
		}),
		lines: table(
			{
				tenantId: text().notNull(),
				lineNo: int().notNull(),
				orderId: fk("orders").as("order").inverse("lines"),
			},
			(t) => [primaryKey(t.tenantId, t.lineNo)],
		),
	});

	it("matches inverse connect with all PK columns", async () => {
		const manifest = schemaToManifest(lineSchema);
		const runtime: QueryRuntime = { manifest };
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"orders",
			"ord_1",
			[
				{
					relationName: "lines",
					value: {
						connect: [{ tenantId: "t1", lineNo: 2 }],
					},
				},
			],
			runCreate,
		);

		const update = executor.queries.find((q) => q.sql.includes("UPDATE"));
		expect(update?.sql).toContain('"tenant_id"');
		expect(update?.sql).toContain('"line_no"');
		expect(update?.params).toEqual(["ord_1", "t1", 2]);
	});

	it("matches inverse delete with all PK columns", async () => {
		const manifest = schemaToManifest(lineSchema);
		const runtime: QueryRuntime = { manifest };
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"orders",
			"ord_1",
			[
				{
					relationName: "lines",
					value: {
						delete: [{ tenantId: "t1", lineNo: 2 }],
					},
				},
			],
			runCreate,
		);

		const del = executor.queries.find((q) => q.sql.includes("DELETE"));
		expect(del?.sql).toMatch(/"tenant_id" = \$2/);
		expect(del?.sql).toMatch(/"line_no" = \$3/);
		expect(del?.params).toEqual(["ord_1", "t1", 2]);
	});
});

describe("composite foreignKey relation writes", () => {
	const orderSchema = defineSchema({
		users: table(
			{
				tenantId: text().notNull(),
				id: text().notNull(),
			},
			(t) => [primaryKey(t.tenantId, t.id)],
		),
		orders: table(
			{
				id: id(),
				tenantId: text().notNull(),
				userId: text().notNull(),
			},
			(t) => [
				foreignKey(t.tenantId, t.userId)
					.references("users", "tenantId", "id")
					.as("user")
					.inverse("orders"),
			],
		),
	});

	it("connect assigns every local FK column", async () => {
		const manifest = schemaToManifest(orderSchema);
		const runtime: QueryRuntime = { manifest };
		const executor = createMockExecutor();
		const table = manifestTable(manifest, "orders");
		const scalarData: Record<string, unknown> = { tenantId: "acme" };

		await applyToOnePreWrites(
			executor,
			runtime,
			table,
			scalarData,
			[
				{
					relationName: "user",
					value: { connect: { tenantId: "acme", id: "u1" } },
				},
			],
			runCreate,
		);

		expect(scalarData.tenantId).toBe("acme");
		expect(scalarData.userId).toBe("u1");
	});
});
