import type { GeoJsonGeometry } from "./columns.js";

/** Spatial `where` operators registered by the PostGIS plugin. */
export type PostgisWhereOperators = {
	intersects?: GeoJsonGeometry;
	within?: GeoJsonGeometry;
	dWithin?: {
		geometry: GeoJsonGeometry;
		distance: number;
	};
};

declare module "neoorm/schema" {
	interface PluginColumnWhereOperators {
		geometry: PostgisWhereOperators;
		geography: PostgisWhereOperators;
		point: PostgisWhereOperators;
	}
}
