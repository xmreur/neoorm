import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("sqlite production pragmas", () => {
	async function pragmaValue(
		client: ReturnType<typeof sqliteClient>,
		name: string,
	): Promise<unknown> {
		const result = await client.query(`PRAGMA ${name}`);
		const row = result.rows[0];
		return row ? Object.values(row)[0] : undefined;
	}

	it("sets busy_timeout and leaves :memory: journal as memory", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		expect(await pragmaValue(client, "busy_timeout")).toBe(5000);
		expect(await pragmaValue(client, "foreign_keys")).toBe(1);
		expect(await pragmaValue(client, "journal_mode")).toBe("memory");
		await client.close();
	});

	it("sets WAL on a file database", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neoorm-wal-"));
		try {
			const db = new DatabaseSync(join(dir, "t.db"));
			const client = sqliteClient(db);
			expect(await pragmaValue(client, "journal_mode")).toBe("wal");
			expect(await pragmaValue(client, "busy_timeout")).toBe(5000);
			await client.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("allows opting out of busy_timeout and WAL", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neoorm-wal-"));
		try {
			const db = new DatabaseSync(join(dir, "t.db"));
			const client = sqliteClient(db, { busyTimeout: false, wal: false });
			expect(await pragmaValue(client, "busy_timeout")).toBe(0);
			expect(await pragmaValue(client, "journal_mode")).not.toBe("wal");
			expect(await pragmaValue(client, "foreign_keys")).toBe(1);
			await client.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts a custom busy_timeout", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db, { busyTimeout: 2500 });
		expect(await pragmaValue(client, "busy_timeout")).toBe(2500);
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
