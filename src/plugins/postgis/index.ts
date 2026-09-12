import { registerPlugin } from "../registry.js";
import { postgisPlugin } from "./plugin.js";

export type {
	GeographyOptions,
	GeoJsonGeometry,
	GeoJsonPoint,
	GeoJsonPolygon,
	GeometryOptions,
	PointOptions,
	SpatialSubtype,
} from "./columns.js";
export { geography, geometry, point, SPATIAL_SUBTYPES } from "./columns.js";
export { postgisPlugin } from "./plugin.js";

registerPlugin(postgisPlugin);
