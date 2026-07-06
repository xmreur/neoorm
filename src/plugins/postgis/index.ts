import { registerPlugin } from "../registry.js";
import { postgisPlugin } from "./plugin.js";

export type {
	GeographyOptions,
	GeoJsonGeometry,
	GeoJsonPoint,
	GeoJsonPolygon,
	GeometryOptions,
	PointOptions,
} from "./columns.js";

export { geography, geometry, point } from "./columns.js";
export { postgisPlugin } from "./plugin.js";

registerPlugin(postgisPlugin);
