import type { GeoJsonGeometry } from "./columns.js";

export function geoJsonToParam(value: unknown): unknown {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string") {
		return value;
	}
	return JSON.stringify(value);
}

export function geoJsonFromValue(dbValue: unknown): GeoJsonGeometry | null {
	if (dbValue === null || dbValue === undefined) {
		return null;
	}
	if (typeof dbValue === "string") {
		return JSON.parse(dbValue) as GeoJsonGeometry;
	}
	if (typeof dbValue === "object") {
		return dbValue as GeoJsonGeometry;
	}
	return null;
}
