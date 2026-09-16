import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mysqlColumnType, mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteColumnType, sqliteDialect } from "../src/dialect/sqlite.js";
import type { ManifestColumn } from "../src/dialect/types.js";
import { resolvePgColumnKind } from "../src/introspect/to-manifest.js";
import {
	cidr,
	date,
	dateRange,
	defineSchema,
	double,
	enumArray,
	float,
	id,
	inet,
	int4Range,
	interval,
	money,
	real,
	table,
	time,
	uuidArray,
	xml,
} from "../src/schema/index.js";

function col(
	overrides: Partial<ManifestColumn> &
		Pick<ManifestColumn, "kind" | "sqlName">,
): ManifestColumn {
	return {
		tsName: overrides.tsName ?? overrides.sqlName,
		nullable: true,
		unique: false,
		primary: false,
		defaultNow: false,
		...overrides,
	};
}

const extraKindsSchema = defineSchema({
	samples: table({
		id: id(),
		ratio: real(),
		alias: float(),
		score: double(),
		born: date(),
		clock: time(),
		span: interval(),
		ip: inet(),
		net: cidr(),
		doc: xml(),
		price: money(),
		window: int4Range(),
		ids: uuidArray(),
		flags: enumArray(["on", "off"]),
	}),
});

describe("extra column kinds", () => {
	it("compiles postgres SQL types", () => {
		const manifest = schemaToManifest(extraKindsSchema);
		const samples = manifest.tables.samples;
		expect(samples).toBeDefined();
		if (!samples) return;
		expect(samples.columns.find((c) => c.tsName === "ratio")?.kind).toBe(
			"real",
		);
		expect(samples.columns.find((c) => c.tsName === "alias")?.kind).toBe(
			"real",
		);
		const sql = postgresDialect.emitCreateTable(samples, { manifest });
		expect(sql).toContain('"ratio" REAL');
		expect(sql).toContain('"score" DOUBLE PRECISION');
		expect(sql).toContain('"born" DATE');
		expect(sql).toContain('"clock" TIME');
		expect(sql).toContain('"span" INTERVAL');
		expect(sql).toContain('"ip" INET');
		expect(sql).toContain('"net" CIDR');
		expect(sql).toContain('"doc" XML');
		expect(sql).toContain('"price" MONEY');
		expect(sql).toContain('"window" INT4RANGE');
		expect(sql).toContain('"ids" UUID[]');
		expect(sql).toContain('"flags" TEXT[]');
	});

	it("emits native enum arrays in native enum mode", () => {
		const schema = defineSchema({
			samples: table({
				id: id(),
				flags: enumArray(["on", "off"], { name: "flag" }),
			}),
		});
		const manifest = schemaToManifest(schema, undefined, {
			enumMode: "native",
		});
		const samples = manifest.tables.samples;
		expect(samples).toBeDefined();
		if (!samples) return;
		const sql = postgresDialect.emitCreateTable(samples, { manifest });
		expect(sql).toContain('"flags" flag[]');
		expect(manifest.enumTypes).toEqual({
			flag: { values: ["on", "off"] },
		});
	});

	it("maps sqlite storage types and rejects ranges", () => {
		expect(sqliteColumnType(col({ kind: "real", sqlName: "r" }))).toBe(
			"REAL",
		);
		expect(sqliteColumnType(col({ kind: "double", sqlName: "d" }))).toBe(
			"REAL",
		);
		expect(sqliteColumnType(col({ kind: "date", sqlName: "d" }))).toBe(
			"TEXT",
		);
		expect(sqliteColumnType(col({ kind: "interval", sqlName: "i" }))).toBe(
			"TEXT",
		);
		expect(sqliteColumnType(col({ kind: "uuidArray", sqlName: "u" }))).toBe(
			"TEXT",
		);
		expect(() =>
			sqliteColumnType(col({ kind: "int4Range", sqlName: "w" })),
		).toThrow(/not supported on SQLite/);

		const portable = defineSchema({
			samples: table({
				id: id(),
				ratio: real(),
				born: date(),
				ids: uuidArray(),
			}),
		});
		const manifest = schemaToManifest(portable, undefined, {
			provider: "sqlite",
		});
		const samples = manifest.tables.samples;
		expect(samples).toBeDefined();
		if (!samples) return;
		const sql = sqliteDialect.emitCreateTable(samples, { manifest });
		expect(sql).toContain('"ratio" REAL');
		expect(sql).toContain('"born" TEXT');
		expect(sql).toContain('"ids" TEXT');

		expect(() =>
			schemaToManifest(
				defineSchema({
					samples: table({
						id: id(),
						window: dateRange(),
					}),
				}),
				undefined,
				{ provider: "sqlite" },
			),
		).toThrow(/not supported on SQLite/);
	});

	it("maps mysql storage types and rejects postgres-only kinds", () => {
		expect(mysqlColumnType(col({ kind: "real", sqlName: "r" }))).toBe(
			"FLOAT",
		);
		expect(mysqlColumnType(col({ kind: "double", sqlName: "d" }))).toBe(
			"DOUBLE",
		);
		expect(mysqlColumnType(col({ kind: "date", sqlName: "d" }))).toBe(
			"DATE",
		);
		expect(mysqlColumnType(col({ kind: "time", sqlName: "t" }))).toBe(
			"TIME",
		);
		expect(mysqlColumnType(col({ kind: "xml", sqlName: "x" }))).toBe(
			"LONGTEXT",
		);
		expect(mysqlColumnType(col({ kind: "money", sqlName: "m" }))).toBe(
			"DECIMAL(19,4)",
		);
		expect(mysqlColumnType(col({ kind: "uuidArray", sqlName: "u" }))).toBe(
			"JSON",
		);

		const portable = defineSchema({
			samples: table({
				id: id(),
				ratio: real(),
				score: double(),
				born: date(),
				doc: xml(),
				price: money(),
				ids: uuidArray(),
			}),
		});
		const manifest = schemaToManifest(portable, undefined, {
			provider: "mysql",
		});
		const samples = manifest.tables.samples;
		expect(samples).toBeDefined();
		if (!samples) return;
		const sql = mysqlDialect.emitCreateTable(samples, { manifest });
		expect(sql).toContain("`ratio` FLOAT");
		expect(sql).toContain("`score` DOUBLE");
		expect(sql).toContain("`born` DATE");
		expect(sql).toContain("`doc` LONGTEXT");
		expect(sql).toContain("`price` DECIMAL(19,4)");
		expect(sql).toContain("`ids` JSON");

		expect(() =>
			schemaToManifest(
				defineSchema({
					samples: table({ id: id(), span: interval() }),
				}),
				undefined,
				{ provider: "mysql" },
			),
		).toThrow(/not supported on MySQL/);
		expect(() =>
			schemaToManifest(
				defineSchema({
					samples: table({ id: id(), ip: inet() }),
				}),
				undefined,
				{ provider: "mariadb" },
			),
		).toThrow(/not supported on MariaDB/);
		expect(() =>
			schemaToManifest(
				defineSchema({
					samples: table({ id: id(), window: int4Range() }),
				}),
				undefined,
				{ provider: "mysql" },
			),
		).toThrow(/not supported on MySQL/);
	});

	it("maps postgres information_schema types to kinds", () => {
		expect(
			resolvePgColumnKind({
				column_name: "ratio",
				data_type: "real",
				udt_name: "float4",
				column_default: null,
			}),
		).toBe("real");
		expect(
			resolvePgColumnKind({
				column_name: "score",
				data_type: "double precision",
				udt_name: "float8",
				column_default: null,
			}),
		).toBe("double");
		expect(
			resolvePgColumnKind({
				column_name: "born",
				data_type: "date",
				udt_name: "date",
				column_default: null,
			}),
		).toBe("date");
		expect(
			resolvePgColumnKind({
				column_name: "clock",
				data_type: "time without time zone",
				udt_name: "time",
				column_default: null,
			}),
		).toBe("time");
		expect(
			resolvePgColumnKind({
				column_name: "ids",
				data_type: "ARRAY",
				udt_name: "_uuid",
				column_default: null,
			}),
		).toBe("uuidArray");
		expect(
			resolvePgColumnKind({
				column_name: "window",
				data_type: "USER-DEFINED",
				udt_name: "int4range",
				column_default: null,
			}),
		).toBe("int4Range");
		expect(
			resolvePgColumnKind(
				{
					column_name: "flags",
					data_type: "ARRAY",
					udt_name: "_flag",
					column_default: null,
				},
				{ flag: ["on", "off"] },
			),
		).toBe("enumArray");
	});
});
