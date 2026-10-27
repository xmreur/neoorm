import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import type { Manifest, ManifestTable } from "../src/dialect/types.js";
import { getColumnTypeOrThrow } from "../src/plugins/registry.js";
import { defineSchema, id, jsonb, table } from "../src/schema/index.js";

const value = { note: "o'b\\c" };
const json = JSON.stringify(value);

function itemsTable(): { manifest: Manifest; table: ManifestTable } {
	const manifest = schemaToManifest(
		defineSchema({
			items: table({
				id: id(),
				meta: jsonb().notNull().default(value),
			}),
		}),
		[],
		{ provider: "postgresql" },
	);
	const tableDef = manifest.tables.items;
	if (!tableDef) throw new Error("missing items table");
	return { manifest, table: tableDef };
}

describe("JSON column defaults", () => {
	it("quotes apostrophes for postgres and sqlite and uses hex for mysql", () => {
		const { manifest, table: items } = itemsTable();
		const quoted = `'${json.replaceAll("'", "''")}'`;
		expect(postgresDialect.emitCreateTable(items, { manifest })).toContain(
			`${quoted}::jsonb`,
		);
		expect(sqliteDialect.emitCreateTable(items, { manifest })).toContain(
			quoted,
		);
		const hex = Buffer.from(json, "utf8").toString("hex");
		const mysqlSql = mysqlDialect.emitCreateTable(items, { manifest });
		const mariadbSql = mariadbDialect.emitCreateTable(items, { manifest });
		expect(mysqlSql).toContain(`(CAST(X'${hex}' AS JSON))`);
		expect(mariadbSql).toContain(`(CAST(X'${hex}' AS JSON))`);
		expect(mysqlSql).not.toContain("\\");
	});

	it("rejects an undefined JSON default instead of emitting the word undefined", () => {
		const plugin = getColumnTypeOrThrow("jsonb");
		const formatDefault = plugin.formatDefault;
		if (!formatDefault) throw new Error("missing formatDefault");
		const column = itemsTable().table.columns.find(
			(col) => col.tsName === "meta",
		);
		if (!column) throw new Error("missing meta column");
		expect(() => formatDefault(column, undefined, postgresDialect)).toThrow(
			/must be a JSON value/,
		);
	});
});
