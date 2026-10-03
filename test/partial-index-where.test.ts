import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { parseIndexWhere } from "../src/introspect/pull.js";
import {
	bool,
	defineSchema,
	index,
	int,
	table,
	text,
	timestamp,
	unique,
} from "../src/schema/index.js";
import type { IndexWherePredicate } from "../src/schema/table.js";

function whereSqlFor(where: IndexWherePredicate, provider?: "sqlite"): string {
	const schema = defineSchema({
		users: table(
			{
				id: text().primary(),
				email: text().notNull(),
				status: text().notNull(),
				score: int().notNull(),
				active: bool().notNull(),
				deletedAt: timestamp(),
			},
			(t) => [unique(t.email).where(where)],
		),
	});
	const manifest = schemaToManifest(
		schema,
		[],
		provider === "sqlite" ? { provider: "sqlite" } : {},
	);
	const users = manifest.tables.users;
	const idx = users?.indexes.find((entry) => entry.unique);
	expect(idx?.whereSql).toBeDefined();
	return idx?.whereSql ?? "";
}

function expectPartialError(where: IndexWherePredicate, pattern: RegExp): void {
	expect(() => whereSqlFor(where)).toThrow(pattern);
}

describe("partial index where: flat equality (backward compatible)", () => {
	it("compiles a single equality", () => {
		expect(whereSqlFor({ status: "banned" })).toBe("\"status\" = 'banned'");
	});

	it("ANDs multiple equalities and maps null to IS NULL", () => {
		expect(whereSqlFor({ status: "banned", deletedAt: null })).toBe(
			'"status" = \'banned\' AND "deleted_at" IS NULL',
		);
	});

	it("escapes single quotes in literals", () => {
		expect(whereSqlFor({ status: "o'brien" })).toBe(
			"\"status\" = 'o''brien'",
		);
	});

	it("maps booleans per provider", () => {
		expect(whereSqlFor({ active: true })).toBe('"active" = true');
		expect(whereSqlFor({ active: true }, "sqlite")).toBe('"active" = 1');
	});
});

describe("partial index where: combinators", () => {
	it("compiles OR branches", () => {
		expect(
			whereSqlFor({
				OR: [{ status: "banned" }, { status: "suspended" }],
			}),
		).toBe(
			"((" +
				"\"status\" = 'banned'" +
				") OR (" +
				"\"status\" = 'suspended'" +
				"))",
		);
	});

	it("compiles NOT", () => {
		expect(whereSqlFor({ NOT: { status: "trial" } })).toBe(
			"NOT (\"status\" = 'trial')",
		);
	});

	it("accepts a single object for AND/OR", () => {
		expect(whereSqlFor({ AND: { status: "banned" } })).toBe(
			"((" + "\"status\" = 'banned'" + "))",
		);
	});

	it("nests AND inside OR", () => {
		expect(
			whereSqlFor({
				OR: [
					{ status: "banned" },
					{ AND: [{ active: true }, { score: { gt: 10 } }] },
				],
			}),
		).toBe(
			'(("status" = \'banned\') OR ((("active" = true) AND ("score" > 10))))',
		);
	});
});

describe("partial index where: column operators", () => {
	it("compiles comparison operators and ANDs multiple ops", () => {
		expect(whereSqlFor({ score: { gt: 10 } })).toBe('"score" > 10');
		expect(whereSqlFor({ score: { gt: 5, lt: 10 } })).toBe(
			'"score" > 5 AND "score" < 10',
		);
		expect(whereSqlFor({ score: { gte: 5, lte: 10 } })).toBe(
			'"score" >= 5 AND "score" <= 10',
		);
	});

	it("compiles equals null to IS NULL", () => {
		expect(whereSqlFor({ deletedAt: { equals: null } })).toBe(
			'"deleted_at" IS NULL',
		);
	});

	it("compiles in / notIn lists", () => {
		expect(whereSqlFor({ status: { in: ["a", "b"] } })).toBe(
			"\"status\" IN ('a', 'b')",
		);
		expect(whereSqlFor({ status: { notIn: ["a", "b"] } })).toBe(
			"\"status\" NOT IN ('a', 'b')",
		);
	});

	it("compiles isNull / isNotNull", () => {
		expect(whereSqlFor({ deletedAt: { isNull: true } })).toBe(
			'"deleted_at" IS NULL',
		);
		expect(whereSqlFor({ deletedAt: { isNotNull: true } })).toBe(
			'"deleted_at" IS NOT NULL',
		);
	});

	it("compiles pattern operators with LIKE escaping", () => {
		expect(whereSqlFor({ status: { contains: "ban" } })).toBe(
			"\"status\" LIKE '%ban%' ESCAPE '\\'",
		);
		expect(whereSqlFor({ status: { startsWith: "ban" } })).toBe(
			"\"status\" LIKE 'ban%' ESCAPE '\\'",
		);
		expect(whereSqlFor({ status: { endsWith: "100%" } })).toBe(
			"\"status\" LIKE '%100\\%' ESCAPE '\\'",
		);
	});

	it("compiles insensitive equals via LOWER", () => {
		expect(
			whereSqlFor({ status: { equals: "BANNED", mode: "insensitive" } }),
		).toBe("LOWER(\"status\") = LOWER('BANNED')");
	});

	it("compiles search to regex", () => {
		expect(whereSqlFor({ status: { search: "foo.*" } })).toBe(
			"\"status\" ~ 'foo.*'",
		);
		expect(
			whereSqlFor({ status: { search: "foo", mode: "insensitive" } }),
		).toBe("\"status\" ~* 'foo'");
		expect(whereSqlFor({ status: { search: "foo" } }, "sqlite")).toBe(
			"\"status\" REGEXP 'foo'",
		);
	});

	it("compiles Date and bigint literals", () => {
		expect(
			whereSqlFor({ deletedAt: new Date("2024-01-02T03:04:05.000Z") }),
		).toBe("\"deleted_at\" = '2024-01-02T03:04:05.000Z'");
		expect(whereSqlFor({ score: { gt: 10n } })).toBe('"score" > 10');
	});
});

describe("partial index where: errors", () => {
	it("rejects an empty predicate", () => {
		expectPartialError({}, /at least one condition/);
	});

	it("rejects empty AND/OR arrays", () => {
		expectPartialError({ AND: [] }, /at least one where object/);
		expectPartialError({ OR: [] }, /at least one where object/);
	});

	it("rejects non-object NOT and AND items", () => {
		expectPartialError(
			{ NOT: "banned" } as unknown as IndexWherePredicate,
			/"NOT" must be a where object/,
		);
		expectPartialError(
			{ AND: ["banned"] } as unknown as IndexWherePredicate,
			/items must be where objects/,
		);
	});

	it("rejects unknown columns with suggestions", () => {
		expectPartialError(
			{ statuz: "banned" } as unknown as IndexWherePredicate,
			/Unknown column "statuz"/,
		);
	});

	it("rejects unknown operators with suggestions", () => {
		expectPartialError(
			{ status: { containz: "ban" } } as unknown as IndexWherePredicate,
			/Unsupported index where operator "containz"/,
		);
	});

	it("rejects invalid mode", () => {
		expectPartialError(
			{
				status: { equals: "x", mode: "loud" },
			} as unknown as IndexWherePredicate,
			/must be "default" or "insensitive"/,
		);
	});

	it("rejects insensitive mode without a string operator", () => {
		expectPartialError(
			{ score: { gt: 1, mode: "insensitive" } },
			/requires a string operator/,
		);
	});

	it("rejects empty in-lists and non-scalar entries", () => {
		expectPartialError({ status: { in: [] } }, /non-empty array/);
		expectPartialError(
			{ status: { in: [null] } } as unknown as IndexWherePredicate,
			/cannot contain null/,
		);
	});

	it("rejects array column values without in", () => {
		expectPartialError(
			{ status: ["a"] } as unknown as IndexWherePredicate,
			/requires a scalar literal/,
		);
	});

	it("rejects isNull without true", () => {
		expectPartialError(
			{ deletedAt: { isNull: false } },
			/"isNull".*requires true/,
		);
	});
});

describe("partial index where: pull round-trip", () => {
	const bySql = new Map([
		["deleted_at", "deletedAt"],
		["status", "status"],
		["score", "score"],
		["active", "active"],
	]);

	it("round-trips flat equality and IS NULL", () => {
		expect(parseIndexWhere("\"status\" = 'banned'", bySql)).toBe(
			'.where({ status: "banned" })',
		);
		expect(parseIndexWhere('"deleted_at" IS NULL', bySql)).toBe(
			".where({ deletedAt: null })",
		);
	});

	it("round-trips OR / NOT", () => {
		expect(
			parseIndexWhere(
				"((\"status\" = 'banned') OR (\"status\" = 'suspended'))",
				bySql,
			),
		).toBe(
			'.where({ OR: [{ status: "banned" }, { status: "suspended" }] })',
		);
		expect(parseIndexWhere("NOT (\"status\" = 'trial')", bySql)).toBe(
			'.where({ NOT: { status: "trial" } })',
		);
	});

	it("merges same-column comparisons", () => {
		expect(parseIndexWhere('"score" > 5 AND "score" < 10', bySql)).toBe(
			".where({ score: { gt: 5, lt: 10 } })",
		);
	});

	it("round-trips IN and pattern operators", () => {
		expect(parseIndexWhere("\"status\" IN ('a', 'b')", bySql)).toBe(
			'.where({ status: { in: ["a", "b"] } })',
		);
		expect(
			parseIndexWhere("\"status\" LIKE '%ban%' ESCAPE '\\'", bySql),
		).toBe('.where({ status: { contains: "ban" } })');
	});

	it("keeps compiled SQL stable through parse and recompile", () => {
		const first = whereSqlFor({
			OR: [{ status: "banned" }, { status: "suspended" }],
		});
		const code = parseIndexWhere(first, bySql);
		expect(code).toBe(
			'.where({ OR: [{ status: "banned" }, { status: "suspended" }] })',
		);
		const second = whereSqlFor({
			OR: [{ status: "banned" }, { status: "suspended" }],
		});
		expect(second).toBe(first);
	});

	it("returns undefined for unparseable predicates", () => {
		expect(
			parseIndexWhere("\"status\" = upper('banned')", bySql),
		).toBeUndefined();
		expect(parseIndexWhere("", bySql)).toBeUndefined();
	});
});

describe("partial index where: index() parity", () => {
	it("compiles the same predicate on non-unique indexes", () => {
		const schema = defineSchema({
			posts: table(
				{
					id: text().primary(),
					title: text().notNull(),
					published: bool().notNull(),
				},
				(t) => [
					index(t.title).where({
						AND: [{ published: true }],
						NOT: { title: { contains: "draft" } },
					}),
				],
			),
		});
		const manifest = schemaToManifest(schema);
		const idx = manifest.tables.posts?.indexes.at(0);
		expect(idx?.unique).toBe(false);
		expect(idx?.whereSql).toBe(
			"((\"published\" = true)) AND NOT (\"title\" LIKE '%draft%' ESCAPE '\\')",
		);
	});
});
