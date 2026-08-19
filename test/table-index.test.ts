import { defineSchema, fk, getManyToManyRegistry, id, table, text } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import { schema as blogSchema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import {
	buildManifestIndex,
	CappedMap,
	columnByTsName,
	columnBySqlName,
	effectiveRelationByName,
	getOrSetSqlCache,
	relationByName,
} from "../src/runtime/query/table-index.js";

const schema = defineSchema({
	users: table("users", {
		id: id.primary(),
		name: text().notNull(),
	}),
	posts: table("posts", {
		id: id.primary(),
		title: text().notNull(),
		authorId: fk("users.id", {
			as: "author",
			inverse: "posts",
			nullable: false,
		}),
	}),
});

describe("table index lookups", () => {
	const manifest = schemaToManifest(schema);
	const index = buildManifestIndex(manifest);
	const usersTable = manifest.tables.users!;
	const postsTable = manifest.tables.posts!;
	const usersIndex = index.get("users")!;

	it("populates columnsBySqlName and effectiveRelationsByName", () => {
		expect(usersIndex.columnsBySqlName.get("id")?.tsName).toBe("id");
		expect(usersIndex.effectiveRelationsByName.has("posts")).toBe(true);
		expect(usersIndex.ownedFkTsNames.has("authorId")).toBe(false);
		expect(index.get("posts")!.ownedFkTsNames.has("authorId")).toBe(true);
	});

	it("resolves columns and relations via map lookups", () => {
		expect(columnByTsName(usersIndex, usersTable, "name")?.sqlName).toBe(
			"name",
		);
		expect(columnBySqlName(usersIndex, usersTable, "name")?.tsName).toBe(
			"name",
		);
		expect(relationByName(usersIndex, usersTable, "posts")?.targetAccessor).toBe(
			"posts",
		);
		expect(
			effectiveRelationByName(usersIndex, manifest, usersTable, "posts")
				?.targetAccessor,
		).toBe("posts");
	});

	it("returns undefined for missing keys", () => {
		expect(columnByTsName(usersIndex, usersTable, "missing")).toBeUndefined();
	});

	it("falls back to array scan when index is absent", () => {
		expect(columnByTsName(undefined, postsTable, "title")?.sqlName).toBe(
			"title",
		);
		expect(relationByName(undefined, postsTable, "author")?.name).toBe("author");
	});

	it("caches updatedAt columns and expressions on index", () => {
		const blogIndex = buildManifestIndex(
			schemaToManifest(blogSchema, getManyToManyRegistry()),
		);
		const postsIndex = blogIndex.get("posts")!;
		const tagsIndex = blogIndex.get("tags")!;

		expect(postsIndex.updatedAtColumns).toHaveLength(1);
		expect(postsIndex.updatedAtSetExprs).toEqual(['"updated_at" = NOW()']);
		expect(tagsIndex.updatedAtColumns).toEqual([]);
		expect(tagsIndex.updatedAtSetExprs).toEqual([]);
	});

	it("tracks needsRowRename and initializes SQL caches", () => {
		expect(usersIndex.needsRowRename).toBe(false);
		expect(usersIndex.renameColumns).toEqual([]);
		expect(usersIndex.insertSqlByKeys).toBeInstanceOf(Map);
		expect(usersIndex.findManySqlBySignature).toBeInstanceOf(Map);

		const blogIndex = buildManifestIndex(
			schemaToManifest(blogSchema, getManyToManyRegistry()),
		);
		const postsIndex = blogIndex.get("posts")!;
		expect(postsIndex.needsRowRename).toBe(true);
		expect(postsIndex.renameColumns.length).toBeGreaterThan(0);
	});

	it("CappedMap evicts the oldest entry past its limit", () => {
		const map = new CappedMap<string, number>(3);
		map.set("a", 1).set("b", 2).set("c", 3);
		map.set("d", 4);
		expect(map.size).toBe(3);
		expect(map.has("a")).toBe(false);
		expect(map.get("b")).toBe(2);
		expect(map.get("d")).toBe(4);

		// updating an existing key must not evict
		map.set("b", 22);
		expect(map.size).toBe(3);
		expect(map.has("c")).toBe(true);
		expect(map.get("b")).toBe(22);
	});

	it("keeps compiled-query caches bounded under many distinct queries", () => {
		const tableIndex = buildManifestIndex(manifest).get("users")!;
		for (let i = 0; i < 1500; i++) {
			getOrSetSqlCache(
				tableIndex.findManySqlBySignature,
				`key-${i}`,
				() => `SELECT ${i}`,
			);
		}
		expect(tableIndex.findManySqlBySignature.size).toBeLessThanOrEqual(1000);
		// recent entries survive, the oldest are evicted
		expect(tableIndex.findManySqlBySignature.get("key-1499")).toBe("SELECT 1499");
		expect(tableIndex.findManySqlBySignature.has("key-0")).toBe(false);
	});
});
