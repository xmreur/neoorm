import { getManyToManyRegistry } from "neoorm/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "../examples/postgis/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { postgisPlugin } from "../src/plugins/postgis/plugin.js";
import {
	clearPluginRegistry,
	getPluginRegistry,
	registerPlugin,
} from "../src/plugins/registry.js";
import { compileWhere } from "../src/runtime/query/compile.js";

describe("postgis where operators", () => {
	beforeEach(() => {
		clearPluginRegistry();
		registerPlugin(postgisPlugin);
	});

	it("compiles intersects", () => {
		const manifest = schemaToManifest(
			schema,
			getManyToManyRegistry(),
			getPluginRegistry(),
		);
		const places = manifest.tables["places"]!;
		const polygon = {
			type: "Polygon",
			coordinates: [
				[
					[0, 0],
					[1, 0],
					[1, 1],
					[0, 1],
					[0, 0],
				],
			],
		};

		const { sql, params } = compileWhere(
			manifest,
			places,
			{ location: { intersects: polygon } },
			postgresDialect,
		);

		expect(sql).toContain("ST_Intersects");
		expect(sql).toContain("ST_GeomFromGeoJSON");
		expect(params[0]).toBe(JSON.stringify(polygon));
	});

	it("compiles within", () => {
		const manifest = schemaToManifest(
			schema,
			getManyToManyRegistry(),
			getPluginRegistry(),
		);
		const places = manifest.tables["places"]!;
		const polygon = {
			type: "Polygon",
			coordinates: [
				[
					[0, 0],
					[1, 0],
					[1, 1],
					[0, 1],
					[0, 0],
				],
			],
		};

		const { sql } = compileWhere(
			manifest,
			places,
			{ location: { within: polygon } },
			postgresDialect,
		);

		expect(sql).toContain("ST_Within");
	});

	it("compiles dWithin", () => {
		const manifest = schemaToManifest(
			schema,
			getManyToManyRegistry(),
			getPluginRegistry(),
		);
		const places = manifest.tables["places"]!;
		const point = { type: "Point", coordinates: [0, 0] };

		const { sql, params } = compileWhere(
			manifest,
			places,
			{ location: { dWithin: { geometry: point, distance: 500 } } },
			postgresDialect,
		);

		expect(sql).toContain("ST_DWithin");
		expect(params).toEqual([JSON.stringify(point), 500]);
	});
});
