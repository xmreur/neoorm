import {
	bool,
	defineSchema,
	fk,
	id,
	index,
	int,
	table,
	text,
	unique,
} from "../src/schema/index.js";

// Typed partial-index predicates via `t.index` / `t.unique` (Option A:
// equality-only, keys + scalar values inferred from the table).
// Each `@ts-expect-error` below FAILS THE CHECK if the bad predicate ever
// starts to compile, so this file verifies both acceptance and rejection.

export const schema = defineSchema({
	items: table(
		{
			id: id(),
			price: int().notNull(),
			published: text().notNull().default("false"),
			archived: bool().notNull().default(false),
		},
		(t) => [
			t.index(t.price).where({ published: "true" }),
			t.unique(t.price).where({ published: "true", archived: false }),
			t.unique(t.price).where({}),
			t.unique(t.price, t.published),
			// legacy globals keep working (untyped predicate)
			index(t.price).where({ published: "true" }),
			unique(t.price).where({ published: "true" }),
			// @ts-expect-error -- unknown column in partial predicate
			t.unique(t.price).where({ nope: "x" }),
			// @ts-expect-error -- wrong scalar type (boolean column given a string)
			t.unique(t.price).where({ archived: "false" }),
			// @ts-expect-error -- operator bags are not supported in partial predicates
			t.unique(t.price).where({ published: { equals: "true" } }),
			// @ts-expect-error -- OR is not supported in partial predicates
			t.unique(t.price).where({ OR: [{ published: "true" }] }),
		],
	),
	bans: table(
		{
			id: id(),
			userId: fk("users.id").notNull(),
		},
		(t) => [t.unique(t.userId).where({})],
	),
});
