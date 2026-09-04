import "neoorm/plugins/postgis";
import { geometry, point } from "neoorm/plugins/postgis";
import { defineSchema, id, table, text } from "neoorm/schema";

export const schema = defineSchema({
	places: table({
		id: id(),
		name: text().notNull(),
		location: geometry({ subtype: "Point", srid: 4326 }).notNull(),
		boundary: point({ srid: 4326 }),
	}),
});
