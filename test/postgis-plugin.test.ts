import { getManyToManyRegistry } from "neoorm/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "../examples/postgis/schema.js";
import { emitModelsTs } from "../src/codegen/emit-models.js";
import { diffManifest } from "../src/codegen/generate.js";
import {
	schemaToManifest,
	validateManifest,
} from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { postgisPlugin } from "../src/plugins/postgis/plugin.js";
import {
	clearPluginRegistry,
	getPluginRegistry,
	registerPlugin,
} from "../src/plugins/registry.js";
import { manifestTable } from "./helpers/manifest.js";

describe("postgis plugin", () => {
	beforeEach(() => {
		clearPluginRegistry();
		registerPlugin(postgisPlugin);
	});

	function postgisManifest() {
		return schemaToManifest(
			schema,
			getManyToManyRegistry(),
			getPluginRegistry(),
		);
	}

	it("converts postgis schema to manifest with extensions", () => {
		const manifest = postgisManifest();
		expect(manifest.extensions).toEqual(["postgis"]);
		expect(validateManifest(manifest)).toEqual([]);

		const places = manifestTable(manifest, "places");
		const location = places.columns.find((c) => c.tsName === "location");
		expect(location?.kind).toBe("geometry");
		expect(location?.typeOptions).toEqual({ subtype: "Point", srid: 4326 });
	});

	it("emits geometry SQL types", () => {
		const manifest = postgisManifest();
		const places = manifestTable(manifest, "places");
		const location = places.columns.find((c) => c.tsName === "location");
		if (!location) {
			throw new Error('expected "location" column on places table');
		}
		expect(postgresDialect.columnType(location)).toBe(
			"geometry(Point,4326)",
		);
	});

	it("emits GeoJSON model types", () => {
		const manifest = postgisManifest();
		const models = emitModelsTs(manifest);
		expect(models).toContain("export type GeoJsonPoint");
		expect(models).toContain("location: GeoJsonGeometry");
		expect(models).toContain("boundary: GeoJsonPoint | null");
	});

	it("prepends CREATE EXTENSION on initial migration", () => {
		const manifest = postgisManifest();
		const { sql, isInitial } = diffManifest(null, manifest);
		expect(isInitial).toBe(true);
		expect(sql[0]).toBe('CREATE EXTENSION IF NOT EXISTS "postgis";');
		expect(sql.some((s) => s.includes("geometry(Point,4326)"))).toBe(true);
	});
});
