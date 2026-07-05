import { registerPlugin } from "../registry.js";
import { postgisPlugin } from "./plugin.js";

export type {
  GeoJsonPoint,
  GeoJsonPolygon,
  GeoJsonGeometry,
  GeometryOptions,
  GeographyOptions,
  PointOptions,
} from "./columns.js";

export { geometry, geography, point } from "./columns.js";
export { postgisPlugin } from "./plugin.js";

registerPlugin(postgisPlugin);
