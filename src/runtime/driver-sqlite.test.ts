import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sqliteClient } from "./driver.js";
import { createSqliteExecutor } from "./executor.js";

describe("sqliteClient connection sharing", () => {
	it("returns one wrapper per database handle", () => {
		const db = new DatabaseSync(":memory:");
		expect(sqliteClient(db)).toBe(sqliteClient(db));
		db.close();
	});

	it("keeps concurrent queries out of an open transaction", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await client.query(
			"CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)",
		);

		let resume!: () => void;
		const blocker = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let inserted!: () => void;
		const didInsert = new Promise<void>((resolve) => {
			inserted = resolve;
		});

		const tx = client.transaction(async (txClient) => {
			await txClient.query("INSERT INTO t (v) VALUES ($1)", ["tx"]);
			inserted();
			await blocker;
			throw new Error("rollback");
		});

		await didInsert;

		const outside = client.query("INSERT INTO t (v) VALUES ($1)", [
			"outside",
		]);
		let outsideDone = false;
		void outside.then(() => {
			outsideDone = true;
		});
		await Promise.resolve();
		expect(outsideDone).toBe(false);

		resume();
		await expect(tx).rejects.toThrow("rollback");
		await outside;

		const rows = await client.query<{ v: string }>("SELECT v FROM t");
		expect(rows.rows.map((row) => row.v)).toEqual(["outside"]);
		await client.close();
	});

	it("shares the mutex between sqliteClient and createSqliteExecutor", async () => {
		const db = new DatabaseSync(":memory:");
		const driver = sqliteClient(db);
		const executor = createSqliteExecutor(db);
		await driver.query(
			"CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)",
		);

		let resume!: () => void;
		const blocker = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let inserted!: () => void;
		const didInsert = new Promise<void>((resolve) => {
			inserted = resolve;
		});

		const tx = driver.transaction(async (txClient) => {
			await txClient.query("INSERT INTO t (v) VALUES ($1)", ["tx"]);
			inserted();
			await blocker;
			throw new Error("rollback");
		});

		await didInsert;
		const outside = executor.query("INSERT INTO t (v) VALUES ($1)", [
			"outside",
		]);
		resume();
		await expect(tx).rejects.toThrow("rollback");
		await outside;

		const rows = await driver.query<{ v: string }>("SELECT v FROM t");
		expect(rows.rows.map((row) => row.v)).toEqual(["outside"]);
		await driver.close();
	});

	it("rolls nested savepoints without aborting the outer transaction", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await client.query(
			"CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)",
		);

		await client.transaction(async (tx) => {
			await tx.query("INSERT INTO t (v) VALUES ($1)", ["keep"]);
			await expect(
				tx.transaction(async (inner) => {
					await inner.query("INSERT INTO t (v) VALUES ($1)", [
						"drop",
					]);
					throw new Error("inner");
				}),
			).rejects.toThrow("inner");
			await tx.query("INSERT INTO t (v) VALUES ($1)", ["also"]);
		});

		const rows = await client.query<{ v: string }>(
			"SELECT v FROM t ORDER BY id",
		);
		expect(rows.rows.map((row) => row.v)).toEqual(["keep", "also"]);
		await client.close();
	});
});

describe("sqlite placeholders", () => {
	it("reuses $1 instead of consuming a second bound value", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		const result = await client.query<{ a: string; b: string }>(
			"SELECT $1 AS a, $1 AS b",
			["hello"],
		);
		expect(result.rows[0]).toEqual({ a: "hello", b: "hello" });
		await client.close();
	});

	it("maps $N to the Nth param regardless of appearance order", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		const result = await client.query<{ a: string; b: string }>(
			"SELECT $2 AS a, $1 AS b",
			["first", "second"],
		);
		expect(result.rows[0]).toEqual({ a: "second", b: "first" });
		await client.close();
	});

	it("does not rewrite $N inside strings or comments", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		const result = await client.query<{ lit: string; a: string }>(
			"SELECT '$1' AS lit, $1 AS a -- $2\n",
			["hello"],
		);
		expect(result.rows[0]).toEqual({ lit: "$1", a: "hello" });
		await client.close();
	});
});
