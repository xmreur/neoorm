import { decimal, defineSchema, numeric, table, text } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import {
	schemaToManifest,
	validateManifest,
} from "../src/codegen/schema-to-manifest.js";
import {
	canAutoCastType,
	postgresDialect,
	typeCastUsing,
} from "../src/dialect/postgres.js";
import type { Manifest, ManifestTable } from "../src/dialect/types.js";

function requireProductsTable(manifest: Manifest): ManifestTable {
	const products = manifest.tables.products;
	if (!products) {
		throw new Error("expected products table in manifest");
	}
	return products;
}

const schema = defineSchema({
	products: table("products", {
		id: text().notNull().primary(),
		price: decimal({ precision: 10, scale: 2 }).notNull().default("0.00"),
		weight: numeric({ precision: 8, scale: 3 }),
	}),
});

describe("decimal/numeric columns", () => {
	it("stores precision and scale in manifest", () => {
		const manifest = schemaToManifest(schema);
		expect(validateManifest(manifest)).toEqual([]);

		const products = requireProductsTable(manifest);
		const price = products.columns.find((c) => c.tsName === "price");
		expect(price?.kind).toBe("decimal");
		expect(price?.typeOptions).toEqual({ precision: 10, scale: 2 });
		expect(price?.defaultValue).toBe("0.00");
	});

	it("emits NUMERIC(p,s) in DDL", () => {
		const manifest = schemaToManifest(schema);
		const products = requireProductsTable(manifest);
		const sql = postgresDialect.emitCreateTable(products);
		expect(sql).toContain(
			"\"price\" NUMERIC(10,2) NOT NULL DEFAULT '0.00'",
		);
		expect(sql).toContain('"weight" NUMERIC(8,3)');
	});

	it("supports text to numeric casts in migrations", () => {
		expect(canAutoCastType("TEXT", "NUMERIC(10,2)")).toBe(true);
		expect(typeCastUsing("price", "TEXT", "NUMERIC(10,2)")).toBe(
			'"price"::numeric',
		);
	});
});
