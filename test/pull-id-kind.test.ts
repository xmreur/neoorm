import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { introspectPostgres } from "../src/introspect/pull.js";
import { pgClient } from "../src/runtime/driver.js";

function mockPool(columns: Record<string, unknown>[]): Pool {
	const query = vi.fn(async (sql: string) => {
		if (sql.includes("information_schema.tables")) {
			return { rows: [{ table_name: "items" }] };
		}
		if (sql.includes("information_schema.columns")) {
			return { rows: columns };
		}
		if (sql.includes("PRIMARY KEY")) {
			const hasId = columns.some((col) => col.column_name === "id");
			return { rows: hasId ? [{ column_name: "id" }] : [] };
		}
		return { rows: [] };
	}) as unknown as Pool["query"];

	return { query } as unknown as Pool;
}

describe("introspectPostgres id column kinds", () => {
	it("emits id() for TEXT id columns", async () => {
		const schema = await introspectPostgres(
			pgClient(
				mockPool([
					{
						column_name: "id",
						data_type: "text",
						udt_name: "text",
						is_nullable: "NO",
						column_default: null,
					},
				]),
			),
		);
		expect(schema).toContain("id: id()");
		expect(schema).not.toContain("id: int()");
	});

	it("emits serial().primary() for SERIAL id, not id()", async () => {
		const schema = await introspectPostgres(
			pgClient(
				mockPool([
					{
						column_name: "id",
						data_type: "integer",
						udt_name: "int4",
						is_nullable: "NO",
						column_default: "nextval('items_id_seq'::regclass)",
					},
				]),
			),
		);
		expect(schema).toContain("id: serial().primary()");
		expect(schema).not.toContain("id: id()");
	});

	it("emits int().primary() for INTEGER id without a sequence", async () => {
		const schema = await introspectPostgres(
			pgClient(
				mockPool([
					{
						column_name: "id",
						data_type: "integer",
						udt_name: "int4",
						is_nullable: "NO",
						column_default: null,
					},
				]),
			),
		);
		expect(schema).toContain("id: int().primary()");
		expect(schema).not.toContain("id: id()");
	});

	it("emits bigint().primary() for BIGINT id, not id()", async () => {
		const schema = await introspectPostgres(
			pgClient(
				mockPool([
					{
						column_name: "id",
						data_type: "bigint",
						udt_name: "int8",
						is_nullable: "NO",
						column_default: null,
					},
				]),
			),
		);
		expect(schema).toContain("id: bigint().primary()");
		expect(schema).not.toContain("id: id()");
	});

	it("still emits uuid().primary() for UUID id", async () => {
		const schema = await introspectPostgres(
			pgClient(
				mockPool([
					{
						column_name: "id",
						data_type: "uuid",
						udt_name: "uuid",
						is_nullable: "NO",
						column_default: null,
					},
				]),
			),
		);
		expect(schema).toContain("id: uuid().primary()");
	});
});
