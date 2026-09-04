# Plugins

## Built-in `id()` and `timestamps()`

```ts
import { defineSchema, id, table, timestamps, uuid } from "neoorm/schema";

export const schema = defineSchema({
  users: table({
    id: uuid().primary(),
    ...timestamps(),
  }),
  posts: table({
    id: id(), // TEXT PK with {prefix}_{uuid}
    title: text().notNull(),
  }),
});
```

## PostGIS

```ts
import "neoorm/plugins/postgis";
import { geometry, point } from "neoorm/plugins/postgis";

places: table({
  id: uuid().primary(),
  location: geometry({ subtype: "Point", srid: 4326 }).notNull(),
  boundary: point({ srid: 4326 }),
}),
```

Spatial `where` operators: `intersects`, `within`, `dWithin`.

## Citext

```ts
import { citext, table } from "neoorm/schema";

users: table({
  email: citext().notNull().unique(),
}),
```

## Custom plugins

See the plugin registry source for `ColumnTypePlugin` and `NeoOrmPlugin` interfaces.
