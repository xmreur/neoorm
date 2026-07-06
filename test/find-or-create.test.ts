import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import {
	buildFindOrCreateQuery,
	compileWhere,
	FIND_OR_CREATE_FLAG,
} from "../src/runtime/query/compile.js";
import { assertUniqueWhere } from "../src/runtime/query/unique.js";
import { getManyToManyRegistry } from "../src/schema/many-to-many.js";
import { manifestTable } from "./helpers/manifest.js";

describe("findOrCreate SQL", () => {
	const manifest = schemaToManifest(schema, getManyToManyRegistry());
	const tags = manifestTable(manifest, "tags");

	it("builds CTE with ON CONFLICT DO NOTHING and created flag", () => {
		const constraint = assertUniqueWhere(
			tags,
			{ slug: "orm" },
			"findOrCreate",
		);
		const insertKeys = ["slug", "name"];
		const insertValues = ["orm", "ORM"];
		const { sql: whereSql, params: whereParams } = compileWhere(
			manifest,
			tags,
			{ slug: "orm" },
			postgresDialect,
			insertValues.length + 1,
		);
		const fallbackWhereBody = whereSql.replace(/^WHERE\s+/i, "");

		const query = buildFindOrCreateQuery(
			tags,
			insertKeys,
			constraint.sqlColumns,
			fallbackWhereBody,
		);

		expect(query).toContain("WITH ins AS (");
		expect(query).toContain('ON CONFLICT ("slug") DO NOTHING');
		expect(query).toContain(`true AS "${FIND_OR_CREATE_FLAG}"`);
		expect(query).toContain(`false AS "${FIND_OR_CREATE_FLAG}"`);
		expect(query).toContain("WHERE NOT EXISTS (SELECT 1 FROM ins)");
		expect(query).toContain("LIMIT 1");
		expect(whereParams).toEqual(["orm"]);
	});
});
