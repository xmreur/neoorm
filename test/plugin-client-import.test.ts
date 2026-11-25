import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitClientTs } from "../src/codegen/generate.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import {
	clearPluginRegistry,
	getColumnType,
	pluginModulesForClient,
} from "../src/plugins/registry.js";
import { compileWhere } from "../src/runtime/query/compile.js";
import { defineSchema, id, table } from "../src/schema/index.js";
import { loyalty } from "./loyalty-plugin.js";
import "../src/plugins/postgis/index.js";

describe("plugin modules on the generated client", () => {
	const clientFile = join(process.cwd(), "generated", "client.ts");

	it("records the plugin module and imports it before createNeoOrmClient", () => {
		const specs = pluginModulesForClient(clientFile, [
			"loyalty",
			"geometry",
		]);
		expect(specs).toContain("neoorm/plugins/postgis");
		expect(specs.some((spec) => spec.endsWith("loyalty-plugin.js"))).toBe(
			true,
		);

		const manifest = schemaToManifest(
			defineSchema({
				items: table({
					id: id(),
					amount: loyalty(),
				}),
			}),
		);
		const items = manifest.tables.items;
		if (!items) {
			throw new Error("items table missing");
		}
		const amount = items.columns.find(
			(column) => column.tsName === "amount",
		);
		expect(amount?.kind).toBe("loyalty");
		const where = compileWhere(
			manifest,
			items,
			{ amount: { overlaps: "1" } },
			postgresDialect,
		);
		expect(where.sql).toContain("&&");

		clearPluginRegistry();
		expect(getColumnType("loyalty")).toBeUndefined();
		expect(() =>
			compileWhere(
				manifest,
				items,
				{ amount: { overlaps: "1" } },
				postgresDialect,
			),
		).toThrow(/unsupported where operator "overlaps"/);

		const client = emitClientTs("neoorm", { pluginModules: specs });
		const importAt = client.indexOf('import "neoorm/plugins/postgis";');
		const createAt = client.indexOf("createNeoOrmClient(manifest)");
		expect(importAt).toBeGreaterThan(-1);
		expect(importAt).toBeLessThan(createAt);
		expect(client).toContain("loyalty-plugin.js");
	});
});
