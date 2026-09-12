import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { QueryErrorCode } from "../src/runtime/error-codes.js";
import { InvalidInputError, isInvalidInput } from "../src/runtime/errors.js";
import { parseDbJsonValue } from "../src/runtime/parse-db-json.js";
import { mapRowToTs } from "../src/runtime/query/map-row.js";
import {
	hydrateRowsWithPlan,
	inlineRelationColumnAlias,
	planRelationLoad,
} from "../src/runtime/query/relation-planner.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { manifestTable } from "./helpers/manifest.js";

describe("parseDbJsonValue", () => {
	it("returns non-string values unchanged", () => {
		const obj = { featured: true };
		expect(parseDbJsonValue(obj)).toBe(obj);
		expect(parseDbJsonValue(null)).toBeNull();
	});

	it("parses valid JSON strings", () => {
		expect(parseDbJsonValue('{"featured":true}')).toEqual({
			featured: true,
		});
	});

	it("wraps SyntaxError in InvalidInputError", () => {
		expect(() =>
			parseDbJsonValue("{not-json", { columnTsName: "metadata" }),
		).toThrow(InvalidInputError);

		try {
			parseDbJsonValue("{not-json", { columnTsName: "metadata" });
		} catch (err) {
			expect(isInvalidInput(err)).toBe(true);
			if (!isInvalidInput(err)) return;
			expect(err.code).toBe(QueryErrorCode.invalid_input);
			expect(err.context.phase).toBe("runtime");
			expect(err.context.columnTsName).toBe("metadata");
			expect(err.cause).toBeInstanceOf(SyntaxError);
		}
	});
});

describe("JSON column hydration", () => {
	it("throws InvalidInputError for corrupt jsonb TEXT", () => {
		const manifest = schemaToManifest(schema);
		const posts = manifestTable(manifest, "posts");

		expect(() =>
			mapRowToTs(undefined, posts, {
				id: "post_1",
				title: "Hello",
				body: "World",
				metadata: "{not-json",
			}),
		).toThrow(InvalidInputError);
	});
});

describe("SQLite json_object hydration", () => {
	it("throws InvalidInputError for corrupt json_agg payloads", () => {
		const manifest = schemaToManifest(schema);
		const tableIndex = buildManifestIndex(manifest);
		const posts = manifestTable(manifest, "posts");
		const plan = planRelationLoad(
			manifest,
			posts,
			{ comments: true },
			sqliteDialect,
			tableIndex,
		);

		expect(plan.inlineJsonAgg.length).toBeGreaterThan(0);

		expect(() =>
			hydrateRowsWithPlan(
				{ manifest, tableIndex, dialect: sqliteDialect },
				posts,
				[
					{
						id: "post_1",
						title: "Hello",
						body: "World",
						[inlineRelationColumnAlias("comments")]: "not-json",
					},
				],
				plan,
			),
		).toThrow(InvalidInputError);
	});
});
