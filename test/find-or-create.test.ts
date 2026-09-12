import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import {
	buildFindOrCreateQuery,
	FIND_OR_CREATE_FLAG,
} from "../src/runtime/query/compile.js";
import { assertUniqueWhere } from "../src/runtime/query/unique.js";
import { manifestTable } from "./helpers/manifest.js";

describe("findOrCreate SQL", () => {
	const manifest = schemaToManifest(schema);
	const tags = manifestTable(manifest, "tags");

	it("builds ON CONFLICT DO UPDATE RETURNING with xmax created flag", () => {
		const { constraint } = assertUniqueWhere(
			tags,
			{ slug: "orm" },
			"findOrCreate",
		);
		const query = buildFindOrCreateQuery(
			tags,
			["slug", "name"],
			constraint.sqlColumns,
		);

		expect(query).toContain('ON CONFLICT ("slug") DO UPDATE SET');
		expect(query).toContain('"slug" = excluded."slug"');
		expect(query).toContain(`(xmax = 0) AS "${FIND_OR_CREATE_FLAG}"`);
		expect(query).toContain("RETURNING");
		expect(query).not.toContain("WITH ins AS");
		expect(query).not.toContain("DO NOTHING");
		expect(query).not.toContain("UNION ALL");
	});
});
