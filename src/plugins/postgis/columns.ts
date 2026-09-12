import type { ManifestColumn } from "../../dialect/types.js";
import { schemaError } from "../../runtime/error-builders.js";
import { SchemaErrorCode } from "../../runtime/error-codes.js";
import type { ColumnMeta } from "../../schema/column.js";
import { createColumnBuilder } from "../../schema/column.js";
import type { ColumnTypePlugin } from "../types.js";
import { geoJsonFromValue, geoJsonToParam } from "./geojson.js";
import { postgisWhereOperators } from "./operators.js";

export type GeoJsonPoint = {
	type: "Point";
	coordinates: [number, number] | [number, number, number];
};

export type GeoJsonPolygon = {
	type: "Polygon";
	coordinates: number[][][];
};

export type GeoJsonGeometry =
	| GeoJsonPoint
	| GeoJsonPolygon
	| Record<string, unknown>;

const SPATIAL_BASE_TYPES = [
	"Geometry",
	"Point",
	"LineString",
	"Polygon",
	"MultiPoint",
	"MultiLineString",
	"MultiPolygon",
	"GeometryCollection",
	"CircularString",
	"CompoundCurve",
	"CurvePolygon",
	"MultiCurve",
	"MultiSurface",
	"PolyhedralSurface",
	"Triangle",
	"TIN",
] as const;

const SPATIAL_DIMENSIONS = ["", "Z", "M", "ZM"] as const;

type SpatialBaseType = (typeof SPATIAL_BASE_TYPES)[number];
type SpatialDimension = (typeof SPATIAL_DIMENSIONS)[number];

/** Canonical PostGIS geometry type, including optional Z/M/ZM. */
export type SpatialSubtype = `${SpatialBaseType}${SpatialDimension}`;

export const SPATIAL_SUBTYPES: readonly SpatialSubtype[] =
	SPATIAL_BASE_TYPES.flatMap((base) =>
		SPATIAL_DIMENSIONS.map((dim) => `${base}${dim}` as SpatialSubtype),
	);

const SPATIAL_SUBTYPE_BY_LOWER = new Map(
	SPATIAL_SUBTYPES.map((subtype) => [subtype.toLowerCase(), subtype]),
);

type SpatialOptionsWithoutSrid = {
	subtype?: SpatialSubtype;
	srid?: never;
};

type SpatialOptionsWithSrid = {
	subtype: SpatialSubtype;
	srid: number;
};

/** PostGIS `geometry` options. `srid` requires a whitelisted `subtype`. */
export type GeometryOptions =
	| SpatialOptionsWithoutSrid
	| SpatialOptionsWithSrid;

export type GeographyOptions = GeometryOptions;

export type PointOptions = {
	srid?: number;
};

type ResolvedSpatialOptions = {
	subtype?: SpatialSubtype;
	srid?: number;
};

function resolveSpatialSubtype(value: unknown): SpatialSubtype | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || value.length === 0) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			`PostGIS subtype must be a geometry type such as Point or Geometry, received ${JSON.stringify(value)}`,
		);
	}
	const canonical = SPATIAL_SUBTYPE_BY_LOWER.get(value.toLowerCase());
	if (canonical === undefined) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			`Invalid PostGIS subtype "${value}". Use a type such as Point, LineString, Polygon, MultiPolygon, or Geometry, optionally with Z, M, or ZM (e.g. PointZ).`,
		);
	}
	return canonical;
}

function resolveSpatialSrid(value: unknown): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			`PostGIS srid must be an integer, received ${JSON.stringify(value)}`,
		);
	}
	return value;
}

function resolveSpatialOptions(
	base: "geometry" | "geography",
	options: Record<string, unknown> | undefined,
): ResolvedSpatialOptions {
	const subtype = resolveSpatialSubtype(options?.subtype);
	const srid = resolveSpatialSrid(options?.srid);
	if (srid !== undefined && subtype === undefined) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			`PostGIS ${base} columns with srid require a subtype. Valid typmod is ${base}(Point,4326), not ${base}(${srid}).`,
			{},
			[
				`Use ${base}({ subtype: "Point", srid: ${srid} })`,
				`Use subtype: "Geometry" to set SRID without constraining the type`,
			],
		);
	}
	return {
		...(subtype !== undefined ? { subtype } : {}),
		...(srid !== undefined ? { srid } : {}),
	};
}

function spatialSqlType(
	base: "geometry" | "geography",
	options?: Record<string, unknown>,
): string {
	const { subtype, srid } = resolveSpatialOptions(base, options);
	if (subtype !== undefined && srid !== undefined) {
		return `${base}(${subtype},${srid})`;
	}
	if (subtype !== undefined) {
		return `${base}(${subtype})`;
	}
	return base;
}

function spatialSelectExpression(col: ManifestColumn): string {
	const sqlName = `"${col.sqlName.replace(/"/g, '""')}"`;
	return `ST_AsGeoJSON(${sqlName})::json AS ${sqlName}`;
}

function spatialWriteExpression(
	col: ManifestColumn,
	paramIndex: number,
): string {
	const srid = resolveSpatialSrid(col.typeOptions?.srid) ?? 4326;
	return `ST_SetSRID(ST_GeomFromGeoJSON($${paramIndex}::json), ${srid})`;
}

function createSpatialTypePlugin(
	kind: "geometry" | "geography" | "point",
	base: "geometry" | "geography",
	defaultOptions?: Record<string, unknown>,
): ColumnTypePlugin {
	return {
		kind,
		createBuilder(options?: Record<string, unknown>) {
			const merged = { ...defaultOptions, ...options };
			if (kind === "point") {
				merged.subtype = "Point";
			}
			const typeOptions = resolveSpatialOptions(base, merged);
			return createColumnBuilder<
				GeoJsonGeometry | null,
				ColumnMeta & {
					kind: typeof kind;
					typeOptions: Record<string, unknown>;
				}
			>({
				kind,
				nullable: true,
				unique: false,
				primary: false,
				defaultNow: false,
				typeOptions,
			});
		},
		columnType(col) {
			return spatialSqlType(base, col.typeOptions);
		},
		columnTsType(col) {
			const tsType =
				kind === "point" ? "GeoJsonPoint" : "GeoJsonGeometry";
			return col.nullable ? `${tsType} | null` : tsType;
		},
		selectExpression: spatialSelectExpression,
		writeExpression: spatialWriteExpression,
		serializeValue(_col, value) {
			return geoJsonToParam(value);
		},
		deserializeValue(_col, dbValue) {
			return geoJsonFromValue(dbValue);
		},
		whereOperators: postgisWhereOperators,
		introspect(_pgDataType, udtName) {
			if (kind === "geography") {
				return udtName === "geography";
			}
			if (kind === "point") {
				return udtName === "geometry";
			}
			return udtName === "geometry";
		},
	};
}

export const geometryType = createSpatialTypePlugin("geometry", "geometry");
export const geographyType = createSpatialTypePlugin("geography", "geography");
export const pointType = createSpatialTypePlugin("point", "geometry", {
	subtype: "Point",
	srid: 4326,
});

/** PostGIS `geometry` column. Requires `import "neoorm/plugins/postgis"`. */
export function geometry(options?: GeometryOptions) {
	return geometryType.createBuilder(
		options as Record<string, unknown> | undefined,
	);
}

/** PostGIS `geography` column. */
export function geography(options?: GeographyOptions) {
	return geographyType.createBuilder(
		options as Record<string, unknown> | undefined,
	);
}

/** PostGIS `geometry(Point,4326)` column with default SRID 4326. */
export function point(options?: PointOptions) {
	return pointType.createBuilder(
		options as Record<string, unknown> | undefined,
	);
}
