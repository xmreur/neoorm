import type { ManifestColumn } from "../../dialect/types.js";
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

export type GeometryOptions = {
	subtype?: string;
	srid?: number;
};

export type GeographyOptions = GeometryOptions;

export type PointOptions = {
	srid?: number;
};

function spatialSqlType(
	base: "geometry" | "geography",
	options?: GeometryOptions,
): string {
	const subtype = options?.subtype;
	const srid = options?.srid;
	if (subtype && srid !== undefined) {
		return `${base}(${subtype},${srid})`;
	}
	if (subtype) {
		return `${base}(${subtype})`;
	}
	if (srid !== undefined) {
		return `${base}(${srid})`;
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
	const srid = (col.typeOptions?.["srid"] as number | undefined) ?? 4326;
	return `ST_SetSRID(ST_GeomFromGeoJSON($${paramIndex}::json), ${srid})`;
}

function createSpatialTypePlugin(
	kind: "geometry" | "geography" | "point",
	base: "geometry" | "geography",
	defaultOptions?: GeometryOptions,
): ColumnTypePlugin {
	return {
		kind,
		createBuilder(options?: Record<string, unknown>) {
			const merged = { ...defaultOptions, ...options };
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
				typeOptions: merged,
			});
		},
		columnType(col) {
			return spatialSqlType(
				base,
				col.typeOptions as GeometryOptions | undefined,
			);
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

export function geometry(options?: GeometryOptions) {
	return geometryType.createBuilder(
		options as Record<string, unknown> | undefined,
	);
}

export function geography(options?: GeographyOptions) {
	return geographyType.createBuilder(
		options as Record<string, unknown> | undefined,
	);
}

export function point(options?: PointOptions) {
	return pointType.createBuilder(
		options as Record<string, unknown> | undefined,
	);
}
