import {
	bool,
	defineSchema,
	expr,
	foreignKey,
	index,
	int,
	primaryKey,
	table,
	text,
	unique,
} from "../src/schema/index.js";

// Key-name validation for `index()` / `unique()` / `primaryKey()` /
// `foreignKey()`: keys from the extras scope (`t.col`) are checked against
// the table's columns, while raw strings stay untyped (back-compat).
// Each `@ts-expect-error` FAILS THE CHECK if the bad call ever compiles.

export const schema = defineSchema({
	items: table(
		{
			price: int().notNull(),
			published: text().notNull().default("false"),
			archived: bool().notNull().default(false),
		},
		(t) => [
			// branded + raw-valid mixes still pass
			unique(t.price, "published"),
			index(t.price, "published"),
			// expression keys always pass
			unique(expr("lower(published)")),
			index(t.price, expr("lower(published)")),
			// pure raw strings stay untyped-accepted
			unique("price", "nope"),
			index("price"),
			// @ts-expect-error -- unknown key mixed with a scoped ref
			unique(t.price, "typo"),
			// @ts-expect-error -- unknown key mixed with a scoped ref
			index(t.price, "typo"),
			// composite PK + FK with scoped refs
			primaryKey(t.price, t.published),
			foreignKey(t.price, t.published)
				.references("o", "a", "b")
				.as("x")
				.inverse("y"),
			// raw PK/FK stay accepted
			primaryKey("price", "published"),
			foreignKey("price", "published")
				.references("o", "a")
				.as("x")
				.inverse("y"),
			// @ts-expect-error -- unknown PK column mixed with a scoped ref
			primaryKey(t.price, "typo"),
			// @ts-expect-error -- unknown FK column mixed with a scoped ref
			foreignKey(t.price, "typo")
				.references("o", "a")
				.as("x")
				.inverse("y"),
		],
	),
});

// Raw-string PKs keep narrow literal types for downstream PK inference.
const rawPk = primaryKey("price", "published");
const _narrow: {
	kind: "primaryKey";
	columns: readonly ["price", "published"];
} = rawPk;
// @ts-expect-error -- PK columns must stay narrow literals
const _widened: {
	kind: "primaryKey";
	columns: readonly ["price", "published"];
} = primaryKey("price", "nope");
