import type { ManifestColumn } from "../../dialect/types.js";
import type { PluginWhereOperator } from "../types.js";
import { geoJsonToParam } from "./geojson.js";

function geomFromGeoJson(paramIndex: number): string {
	return `ST_GeomFromGeoJSON($${paramIndex}::json)`;
}

export const postgisWhereOperators: Record<string, PluginWhereOperator> = {
	intersects: {
		compile(sqlCol, value, _col, startParamIndex) {
			return {
				sql: `ST_Intersects(${sqlCol}, ${geomFromGeoJson(startParamIndex)})`,
				params: [geoJsonToParam(value)],
			};
		},
	},
	within: {
		compile(sqlCol, value, _col, startParamIndex) {
			return {
				sql: `ST_Within(${sqlCol}, ${geomFromGeoJson(startParamIndex)})`,
				params: [geoJsonToParam(value)],
			};
		},
	},
	dWithin: {
		compile(sqlCol, value, _col, startParamIndex) {
			const payload = value as { geometry: unknown; distance: number };
			return {
				sql: `ST_DWithin(${sqlCol}, ${geomFromGeoJson(startParamIndex)}, $${startParamIndex + 1})`,
				params: [geoJsonToParam(payload.geometry), payload.distance],
			};
		},
	},
};

export function isPostgisColumn(col: ManifestColumn): boolean {
	return (
		col.kind === "geometry" ||
		col.kind === "geography" ||
		col.kind === "point"
	);
}
