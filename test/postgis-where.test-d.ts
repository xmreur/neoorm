import "neoorm/plugins/postgis";
import type { schema } from "../examples/postgis/schema.js";
import type { WhereInput } from "../src/schema/types.js";

type Schema = typeof schema._tables;
type PlacesWhere = WhereInput<Schema["places"]["_columns"], Schema, "places">;

function expectPlacesWhere(value: PlacesWhere): void {
	void value;
}

const point = {
	type: "Point" as const,
	coordinates: [-122.4, 37.8] as [number, number],
};
const polygon = {
	type: "Polygon" as const,
	coordinates: [
		[
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
			[0, 0],
		],
	],
};

expectPlacesWhere({
	location: { intersects: polygon },
});

expectPlacesWhere({
	location: { within: polygon },
});

expectPlacesWhere({
	location: {
		dWithin: {
			geometry: point,
			distance: 1000,
		},
	},
});

expectPlacesWhere({
	boundary: { intersects: polygon },
});

expectPlacesWhere({
	name: { contains: "Park" },
});

// @ts-expect-error -- text columns do not support spatial operators
expectPlacesWhere({ name: { intersects: polygon } });

// @ts-expect-error -- text columns do not support dWithin
expectPlacesWhere({ name: { dWithin: { geometry: point, distance: 1 } } });
