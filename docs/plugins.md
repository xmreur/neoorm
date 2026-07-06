# Plugins

## PostGIS

```ts
import "neoorm/plugins/postgis";
import { geometry, point } from "neoorm/plugins/postgis";

places: table("places", {
  id: uuid().primary(),
  location: geometry({ subtype: "Point", srid: 4326 }).notNull(),
  boundary: point({ srid: 4326 }),
})
```

Spatial `where` operators: `intersects`, `within`, `dWithin`.

```ts
await db.places.findMany({
  where: {
    location: {
      dWithin: {
        geometry: { type: "Point", coordinates: [-122.4, 37.8] },
        distance: 1000,
      },
    },
  },
});
```

PostGIS columns are stored as geometry/geography in PostgreSQL and exposed as GeoJSON in TypeScript.

## Citext

`citext()` is registered as a separate plugin that enables the `citext` extension when used in a schema:

```ts
import { citext, table } from "neoorm/schema";

users: table("users", {
  email: citext().notNull().unique(),
})
```

## Custom plugins

See the [plugin registry](https://github.com/xmreur/neoorm/src/plugins) source for the plugin interface.
