import type { NeoOrmPlugin } from "../types.js";
import { geographyType, geometryType, pointType } from "./columns.js";

export const postgisPlugin: NeoOrmPlugin = {
	name: "postgis",
	extensions: ["postgis"],
	columnTypes: [geometryType, geographyType, pointType],
};
