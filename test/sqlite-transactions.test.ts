import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { dbPush } from "../src/migrate/runner.js";
import { defineSchema, int, table, text } from "../src/schema/index.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { createNeoOrmClientFromSqlite } from "../src/runtime/client.js";
import { sqliteClient, type SqliteDatabaseLike } from "../src/runtime/driver.js";

const schema = defineSchema({
	items: table("items", {
		id: text().primary(),
		n: int().notNull(),
	}),
});

const manifest = schemaToManifest(schema);

async function setup(): Promise<{
	db: SqliteDatabaseLike;
	orm: ReturnType<
		typeof createNeoOrmClientFromSqlite<
			typeof schema._tables,
			Record<string, never>,
			Record<string, Record<string, unknown>>
		>
	>;
}> {
	const db = new DatabaseSync(":memory:");
	await dbPush(sqliteClient(db), sqliteDialect, manifest);
	return {
		db,
		orm: createNeoOrmClientFromSqlite(manifest, db),
	};
}

describe("sqlite concurrent transactions", () => {
	it("a rolling-back transaction does not destroy another transaction's in-flight writes", async () => {
		const { orm, db } = await setup();

		const t1 = orm.$transaction(async (tx) => {
			await tx.items.create({ data: { n: 1 } });
			await new Promise((r) => setTimeout(r, 60));
			return "t1-done";
		});

		const t2 = orm
			.$transaction(async (tx) => {
				await tx.items.create({ data: { n: 2 } });
				throw new Error("t2 wants rollback");
			})
			.catch(() => "t2-rolled-back");

		const [r1, r2] = await Promise.all([t1, t2]);
		expect(r1).toBe("t1-done");
		expect(r2).toBe("t2-rolled-back");

		const rows = await orm.items.findMany();
		expect(rows.map((r) => r.n).sort()).toEqual([1]);
		db.close();
	});

	it("serializes concurrent transactions so all commits persist", async () => {
		const { orm, db } = await setup();

		await Promise.all([
			orm.$transaction(async (tx) => {
				await tx.items.create({ data: { n: 1 } });
			}),
			orm.$transaction(async (tx) => {
				await tx.items.create({ data: { n: 2 } });
			}),
			orm.$transaction(async (tx) => {
				await tx.items.create({ data: { n: 3 } });
			}),
		]);

		const rows = await orm.items.findMany();
		expect(rows.map((r) => r.n).sort()).toEqual([1, 2, 3]);
		db.close();
	});

	it("nested savepoints still roll back only their own work", async () => {
		const { orm, db } = await setup();

		await orm.$transaction(async (tx) => {
			await tx.items.create({ data: { n: 1 } });
			await tx
				.$transaction(async (inner) => {
					await inner.items.create({ data: { n: 2 } });
					throw new Error("inner rollback");
				})
				.catch(() => {});
		});

		const rows = await orm.items.findMany();
		expect(rows.map((r) => r.n)).toEqual([1]);
		db.close();
	});
});
