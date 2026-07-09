import { defineSchema, fk, id, primaryKey, table, text } from "neoorm/schema";
import { describe, expect, it, vi } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import {
	buildFindByIdQuery,
	compileWhere,
} from "../src/runtime/query/compile.js";
import { deleteById } from "../src/runtime/query/delete.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { findById, loadRelations } from "../src/runtime/query/find.js";
import {
	fillMissingPrimaryKeys,
	primaryKeyTsNames,
	requireScalarPrimaryKey,
	rowPkKey,
	rowScalarPkValue,
	targetRelationPkSql,
} from "../src/runtime/query/primary-key.js";
import { executeRelationWrites } from "../src/runtime/query/relation-writes.js";
import { updateById } from "../src/runtime/query/update.js";
import { createMockExecutor } from "./helpers/mock-executor.js";
import { manifestTable } from "./helpers/manifest.js";

const mappedPkSchema = defineSchema({
	users: table("users", {
		id: id.primary().map("user_id"),
		email: text().notNull(),
	}),

	posts: table("posts", {
		id: id.primary(),
		authorId: fk("users.id", {
			as: "author",
			inverse: "posts",
			nullable: false,
		}),
		title: text().notNull(),
	}),
});

const compositePkSchema = defineSchema({
	items: table(
		"items",
		{
			tenantId: text().notNull(),
			itemCode: text().notNull(),
			name: text().notNull(),
		},
		(t) => ({
			pk: primaryKey(t.tenantId, t.itemCode),
		}),
	),
});

describe("manifest-driven primary keys", () => {
	const manifest = schemaToManifest(mappedPkSchema);
	const runtime: QueryRuntime = { manifest };
	const users = manifestTable(manifest, "users");
	const posts = manifestTable(manifest, "posts");

	it("resolves mapped PK in manifest", () => {
		expect(users.primaryKey).toEqual(["user_id"]);
		expect(primaryKeyTsNames(users)).toEqual(["id"]);
		expect(requireScalarPrimaryKey(users)).toEqual({
			tsName: "id",
			sqlName: "user_id",
		});
	});

	it("resolves FK relation targetColumn from fkTarget against mapped PK", () => {
		const authorRel = posts.relations.find((r) => r.name === "author");
		expect(authorRel?.targetColumn).toBe("user_id");
		expect(targetRelationPkSql(users, authorRel)).toBe("user_id");
	});

	it("compiles findById where using PK ts name and mapped sql column", () => {
		const { sql } = compileWhere(
			manifest,
			users,
			{ id: "user_1" },
			postgresDialect,
		);
		expect(sql).toContain('"user_id" = $1');

		const findSql = buildFindByIdQuery(users);
		expect(findSql).toContain('WHERE "user_id" = $1');
	});

	it("reads scalar PK from TS-shaped rows", () => {
		const row = { id: "user_1", email: "a@example.com" };
		expect(rowScalarPkValue(row, users)).toBe("user_1");
		expect(rowPkKey(row, users)).toBe("user_1");
	});

	it("throws for composite PK on requireScalarPrimaryKey", () => {
		const compositeManifest = schemaToManifest(compositePkSchema);
		const items = manifestTable(compositeManifest, "items");
		expect(() => requireScalarPrimaryKey(items)).toThrow(
			"single-column primary key",
		);
	});

	it("keeps the generic scalar PK error without operation context", () => {
		const compositeManifest = schemaToManifest(compositePkSchema);
		const items = manifestTable(compositeManifest, "items");
		expect(() => requireScalarPrimaryKey(items)).toThrow(
			'Operation requires a single-column primary key on table "items"',
		);
	});

	it("rejects string id for composite PK tables in findById", async () => {
		const compositeManifest = schemaToManifest(compositePkSchema);
		const compositeRuntime: QueryRuntime = { manifest: compositeManifest };
		const executor = createMockExecutor();

		await expect(
			findById(executor, compositeRuntime, "items", "item_1"),
		).rejects.toThrow(
			'Table "items" has a composite primary key. Pass an object with PK columns (tenantId, itemCode) instead of a string.',
		);
	});

	it("accepts object id for composite PK in findById", async () => {
		const compositeManifest = schemaToManifest(compositePkSchema);
		const compositeRuntime: QueryRuntime = { manifest: compositeManifest };
		const executor = createMockExecutor();

		const result = await findById(executor, compositeRuntime, "items", {
			tenantId: "t1",
			itemCode: "c1",
		});
		expect(result).toBeNull();
	});

	it("rejects missing PK columns in object id for findById", async () => {
		const compositeManifest = schemaToManifest(compositePkSchema);
		const compositeRuntime: QueryRuntime = { manifest: compositeManifest };
		const executor = createMockExecutor();

		await expect(
			findById(executor, compositeRuntime, "items", {
				tenantId: "t1",
			}),
		).rejects.toThrow(
			'Missing primary key column "itemCode" for table "items"',
		);
	});

	it("rejects string id for composite PK in updateById", async () => {
		const compositeManifest = schemaToManifest(compositePkSchema);
		const compositeRuntime: QueryRuntime = { manifest: compositeManifest };
		const executor = createMockExecutor();

		await expect(
			updateById(executor, compositeRuntime, "items", "item_1", {
				data: { name: "Updated" },
			}),
		).rejects.toThrow(
			'Table "items" has a composite primary key. Pass an object with PK columns (tenantId, itemCode) instead of a string.',
		);
	});

	it("rejects string id for composite PK in deleteById", async () => {
		const compositeManifest = schemaToManifest(compositePkSchema);
		const compositeRuntime: QueryRuntime = { manifest: compositeManifest };
		const executor = createMockExecutor();

		await expect(
			deleteById(executor, compositeRuntime, "items", "item_1"),
		).rejects.toThrow(
			'Table "items" has a composite primary key. Pass an object with PK columns (tenantId, itemCode) instead of a string.',
		);
	});

	it("builds composite rowPkKey from all PK columns", () => {
		const compositeManifest = schemaToManifest(compositePkSchema);
		const items = manifestTable(compositeManifest, "items");
		const row = { tenantId: "t1", itemCode: "c1", name: "Widget" };
		expect(rowPkKey(row, items)).toBe("t1\0c1");
	});

	it("skips fillMissingPrimaryKeys when all PKs are provided", () => {
		const data = { id: "user_abc", name: "Ada" };
		fillMissingPrimaryKeys(users, data);
		expect(data.id).toBe("user_abc");
		expect(data.name).toBe("Ada");
	});

	it("fills only missing composite PK columns", () => {
		const compositeManifest = schemaToManifest(compositePkSchema);
		const items = manifestTable(compositeManifest, "items");
		const data: Record<string, unknown> = {
			tenantId: "t1",
			name: "Widget",
		};
		fillMissingPrimaryKeys(items, data);
		expect(data.tenantId).toBe("t1");
		expect(typeof data.itemCode).toBe("string");
		expect(data.name).toBe("Widget");
	});

	it("loads to-one relation using target PK sql column", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.includes("FROM") && sql.includes("users")) {
					return [{ user_id: "user_1", email: "a@example.com" }];
				}
				return [];
			},
		});

		const parentRows: Record<string, unknown>[] = [
			{ id: "post_1", title: "Hello", authorId: "user_1" },
		];
		await loadRelations(executor, runtime, posts, parentRows, {
			author: true,
		});

		expect(executor.queries[0]?.sql).toContain('"user_id" IN');
		expect(parentRows[0]?.author).toEqual({
			id: "user_1",
			email: "a@example.com",
		});
	});

	it("uses target PK sql column in inverse-many connect SQL", async () => {
		const childMappedSchema = defineSchema({
			teams: table("teams", {
				id: id.primary(),
				name: text().notNull(),
			}),
			members: table("members", {
				id: id.primary().map("member_id"),
				teamId: fk("teams.id", {
					as: "team",
					inverse: "members",
					nullable: true,
				}),
				name: text().notNull(),
			}),
		});

		const childManifest = schemaToManifest(childMappedSchema);
		const childRuntime: QueryRuntime = { manifest: childManifest };
		const executor = createMockExecutor();
		const runCreate = vi.fn();

		await executeRelationWrites(
			executor,
			childRuntime,
			"teams",
			"team_1",
			[
				{
					relationName: "members",
					value: { connect: [{ id: "member_1" }] },
				},
			],
			runCreate,
		);

		const updateSql = executor.queries.find((q) =>
			q.sql.includes("UPDATE"),
		);
		expect(updateSql?.sql).toContain('WHERE "member_id" IN');
	});
});
