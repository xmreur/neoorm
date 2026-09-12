import { describe, expect, it } from "vitest";
import type { ManifestColumn } from "../../dialect/types.js";
import { NeoOrmSchemaError } from "../../runtime/errors.js";
import {
	geography,
	geographyType,
	geometry,
	geometryType,
	point,
	pointType,
} from "./columns.js";

function spatialColumn(
	kind: "geometry" | "geography" | "point",
	typeOptions?: Record<string, unknown>,
): ManifestColumn {
	return {
		tsName: "location",
		sqlName: "location",
		kind,
		nullable: true,
		unique: false,
		primary: false,
		defaultNow: false,
		...(typeOptions !== undefined ? { typeOptions } : {}),
	};
}

describe("PostGIS spatial SQL types", () => {
	it("emits unconstrained geometry with no options", () => {
		expect(geometryType.columnType(spatialColumn("geometry"))).toBe(
			"geometry",
		);
		expect(geometry()._meta.typeOptions).toEqual({});
	});

	it("emits subtype-only typmod", () => {
		expect(
			geometryType.columnType(
				spatialColumn("geometry", { subtype: "Polygon" }),
			),
		).toBe("geometry(Polygon)");
	});

	it("emits canonical subtype and srid typmod", () => {
		expect(
			geometryType.columnType(
				spatialColumn("geometry", { subtype: "point", srid: 4326 }),
			),
		).toBe("geometry(Point,4326)");
		expect(
			geographyType.columnType(
				spatialColumn("geography", {
					subtype: "Geometry",
					srid: 4326,
				}),
			),
		).toBe("geography(Geometry,4326)");
	});

	it("emits PointZ and rejects unknown subtypes", () => {
		expect(
			geometryType.columnType(
				spatialColumn("geometry", { subtype: "PointZ", srid: 4326 }),
			),
		).toBe("geometry(PointZ,4326)");
		expect(() =>
			geometryType.columnType(
				spatialColumn("geometry", {
					subtype: "Point);DROP TABLE t;--",
					srid: 4326,
				}),
			),
		).toThrow(/Invalid PostGIS subtype/);
	});

	it("rejects srid without subtype instead of geometry(4326)", () => {
		expect(() =>
			geometryType.columnType(spatialColumn("geometry", { srid: 4326 })),
		).toThrow(/geometry\(Point,4326\), not geometry\(4326\)/);
		expect(() => geometryType.createBuilder({ srid: 4326 })).toThrow(
			NeoOrmSchemaError,
		);
		expect(() => geometryType.createBuilder({ srid: 4326 })).toThrow(
			/srid require a subtype/,
		);
	});

	it("rejects a non-integer srid", () => {
		expect(() =>
			geometryType.columnType(
				spatialColumn("geometry", { subtype: "Point", srid: 4326.5 }),
			),
		).toThrow(/srid must be an integer/);
	});

	it("point() always uses geometry(Point) with default srid 4326", () => {
		expect(point()._meta.typeOptions).toEqual({
			subtype: "Point",
			srid: 4326,
		});
		expect(point({ srid: 3857 })._meta.typeOptions).toEqual({
			subtype: "Point",
			srid: 3857,
		});
		expect(
			pointType.columnType(
				spatialColumn("point", { subtype: "Point", srid: 4326 }),
			),
		).toBe("geometry(Point,4326)");
	});

	it("stores canonical options on geometry() and geography()", () => {
		expect(
			geometryType.createBuilder({
				subtype: "LINESTRING",
				srid: 4326,
			})._meta.typeOptions,
		).toEqual({ subtype: "LineString", srid: 4326 });
		expect(geography({ subtype: "Point" })._meta.typeOptions).toEqual({
			subtype: "Point",
		});
	});
});
