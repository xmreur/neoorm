import "neoorm/plugins/postgis";
import { defineSchema, table, id, text } from "neoorm/schema";
import { geometry, point } from "neoorm/plugins/postgis";

export const schema = defineSchema({
  places: table("places", {
    id: id.primary(),
    name: text().notNull(),
    location: geometry({ subtype: "Point", srid: 4326 }).notNull(),
    boundary: point({ srid: 4326 }),
  }),
});
