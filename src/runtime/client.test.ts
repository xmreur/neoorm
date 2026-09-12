import { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { emptyManifest } from "../codegen/diff-manifest.js";
import { schemaToManifest } from "../codegen/schema-to-manifest.js";
import { sqliteDialect } from "../dialect/sqlite.js";
import { defineSchema, id, table, text } from "../schema/index.js";
import { createNeoOrmClient, createNeoOrmClientFromPool } from "./client.js";
import { QueryErrorCode } from "./error-codes.js";

function fakePool(): Pool & { end: ReturnType<typeof vi.fn> } {
	return {
		end: vi.fn(async () => undefined),
		query: vi.fn(),
		connect: vi.fn(),
	} as unknown as Pool & { end: ReturnType<typeof vi.fn> };
}

describe("createNeoOrmClientFromPool", () => {
	it("does not end the caller's pool on $disconnect", async () => {
		const pool = fakePool();
		const client = createNeoOrmClientFromPool(emptyManifest(), pool);
		await client.$disconnect();
		expect(pool.end).not.toHaveBeenCalled();
	});
});

const nestedSchema = defineSchema({
	items: table({
		id: id(),
		name: text().notNull(),
	}),
});

describe("nested $transaction options", () => {
	function openClient() {
		const database = new DatabaseSync(":memory:");
		const manifest = schemaToManifest(nestedSchema);
		const items = manifest.tables.items;
		if (!items) {
			throw new Error("expected items table");
		}
		database.exec(sqliteDialect.emitCreateTable(items, { manifest }));
		return createNeoOrmClient<typeof nestedSchema._tables>(manifest, {
			db: database,
		});
	}

	it("rejects isolationLevel and readOnly instead of dropping them", async () => {
		const db = openClient();
		await db.$transaction(async (tx) => {
			await expect(
				// @ts-expect-error nested isolationLevel is illegal
				tx.$transaction(async () => undefined, {
					isolationLevel: "Serializable",
				}),
			).rejects.toMatchObject({
				code: QueryErrorCode.invalid_args,
			});
			await expect(
				// @ts-expect-error nested readOnly is illegal
				tx.$transaction(async () => undefined, { readOnly: true }),
			).rejects.toThrow(/cannot be used with nested transactions/);
		});
		await db.$disconnect();
	});

	it("still uses a savepoint when nested options are omitted", async () => {
		const db = openClient();
		await db.$transaction(async (tx) => {
			await tx.items.create({ data: { name: "keep" } });
			await expect(
				tx.$transaction(async (nested) => {
					await nested.items.create({ data: { name: "drop" } });
					throw new Error("inner");
				}),
			).rejects.toThrow("inner");
		});
		const rows = await db.items.findMany({ orderBy: { name: "asc" } });
		expect(rows.map((row) => row.name)).toEqual(["keep"]);
		await db.$disconnect();
	});
});
