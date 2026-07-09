import { defineSchema, fk, id, table, text } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import {
	buildManifestIndex,
	columnByTsName,
	columnBySqlName,
	effectiveRelationByName,
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
});
