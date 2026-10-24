import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sqliteClient } from "./driver.js";
import { createSqliteExecutor } from "./executor.js";
import { SavepointStackError } from "./transaction.js";

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
					expect(inner).toBe(tx);
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

	it("aborts the outer transaction when RELEASE fails after ROLLBACK TO", async () => {
		const raw = new DatabaseSync(":memory:");
		const log: string[] = [];
		const db = {
			prepare(sql: string) {
				return raw.prepare(sql);
			},
			exec(sql: string) {
				log.push(sql);
				const previous = log.at(-2);
				if (
					sql.startsWith("RELEASE SAVEPOINT") &&
					previous?.startsWith("ROLLBACK TO SAVEPOINT")
				) {
					throw new Error("release failed");
				}
				raw.exec(sql);
			},
			close() {
				raw.close();
			},
		};
		const client = sqliteClient(db);
		await client.query(
			"CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)",
		);

		await expect(
			client.transaction(async (tx) => {
				await tx.query("INSERT INTO t (v) VALUES ($1)", ["keep"]);
				await tx.transaction(async (inner) => {
					await inner.query("INSERT INTO t (v) VALUES ($1)", [
						"drop",
					]);
					throw new Error("inner boom");
				});
			}),
		).rejects.toThrow("inner boom");

		const control = log.filter((sql) => !sql.startsWith("PRAGMA"));
		expect(control).toEqual([
			"BEGIN",
			"SAVEPOINT neoorm_sp_1",
			"ROLLBACK TO SAVEPOINT neoorm_sp_1",
			"RELEASE SAVEPOINT neoorm_sp_1",
			"ROLLBACK",
		]);
		expect(
			raw
				.prepare("SELECT v FROM t")
				.all()
				.map((row) => row.v),
		).toEqual([]);

		let nestedMessage = "";
		await expect(
			client.transaction(async (tx) => {
				try {
					await tx.transaction(async () => {
						throw new Error("inner boom");
					});
				} catch (err) {
					nestedMessage = err instanceof Error ? err.message : "";
					await tx.query("INSERT INTO t (v) VALUES ($1)", ["after"]);
				}
			}),
		).rejects.toBeInstanceOf(SavepointStackError);
		expect(nestedMessage).toBe("inner boom");
		expect(log).not.toContain("COMMIT");
		expect(
			raw
				.prepare("SELECT v FROM t")
				.all()
				.map((row) => row.v),
		).toEqual([]);

		await client.transaction(async (tx) => {
			await tx.query("INSERT INTO t (v) VALUES ($1)", ["later"]);
		});
		expect(
			raw
				.prepare("SELECT v FROM t")
				.all()
				.map((row) => row.v),
		).toEqual(["later"]);
		await client.close();
	});

	it("reuses one executor for nested transaction() callbacks", async () => {
		const db = new DatabaseSync(":memory:");
		const executor = createSqliteExecutor(db);
		await executor.transaction(async (tx) => {
			expect(tx.inTransaction).toBe(true);
			await tx.transaction(async (nested) => {
				expect(nested).toBe(tx);
			});
		});
		db.close();
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

	it("re-applies changed pragmas instead of ignoring later options", async () => {
		// The WeakMap caches one wrapper per db handle. A second call with
		// different options must honor them (not silently keep the first
		// wrap's pragmas) while still returning the same wrapper/mutex.
		const db = new DatabaseSync(":memory:");
		const first = sqliteClient(db, { busyTimeout: 2500 });
		const second = sqliteClient(db, { busyTimeout: 100 });
		expect(second).toBe(first);
		expect(await pragmaValue(second, "busy_timeout")).toBe(100);

		// busyTimeout: false must reset to the engine default (0), not leave
		// the prior 100 in place.
		const third = sqliteClient(db, { busyTimeout: false });
		expect(third).toBe(first);
		expect(await pragmaValue(third, "busy_timeout")).toBe(0);
		await first.close();
	});

	it("keeps one wrapper for identical options", async () => {
		const db = new DatabaseSync(":memory:");
		const a = sqliteClient(db, { busyTimeout: 1234 });
		const b = sqliteClient(db, { busyTimeout: 1234 });
		expect(b).toBe(a);
		await a.close();
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

describe("sqlite readOnly transactions", () => {
	it("rejects writes inside readOnly and allows them afterward", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await client.query(
			"CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)",
		);

		await expect(
			client.transaction(
				async (tx) => {
					await tx.query("INSERT INTO t (v) VALUES ($1)", ["nope"]);
				},
				{ readOnly: true },
			),
		).rejects.toThrow(/readonly/i);

		await client.query("INSERT INTO t (v) VALUES ($1)", ["ok"]);
		const rows = await client.query<{ v: string }>("SELECT v FROM t");
		expect(rows.rows.map((row) => row.v)).toEqual(["ok"]);
		await client.close();
	});

	it("allows reads in a readOnly transaction", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await client.query(
			"CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)",
		);
		await client.query("INSERT INTO t (v) VALUES ($1)", ["kept"]);

		const value = await client.transaction(
			async (tx) => {
				const result = await tx.query<{ v: string }>("SELECT v FROM t");
				return result.rows[0]?.v;
			},
			{ readOnly: true },
		);
		expect(value).toBe("kept");
		await client.close();
	});
});

describe("sqlite placeholder conversion $-quoting", () => {
	function recordingClient(): {
		client: ReturnType<typeof sqliteClient>;
		prepared: string[];
	} {
		const prepared: string[] = [];
		const fake = {
			prepare(sql: string) {
				prepared.push(sql);
				return {
					all: () => [] as Record<string, unknown>[],
					get: () => undefined,
					run: () => ({ changes: 0, lastInsertRowid: 0 }),
				};
			},
			exec(sql: string) {
				prepared.push(sql);
			},
			close() {},
		};
		return { client: sqliteClient(fake), prepared };
	}

	function lastNonPragma(prepared: string[]): string {
		return prepared.find((sql) => !sql.startsWith("PRAGMA")) ?? "";
	}

	it("copies $-quoted regions verbatim while converting real placeholders", async () => {
		const { client, prepared } = recordingClient();
		await client.query("SELECT $1, $$ body with $2 $$ AS b", ["a", "b"]);
		expect(lastNonPragma(prepared)).toBe(
			"SELECT ?1, $$ body with $2 $$ AS b",
		);
	});

	it("copies tagged $-quoted regions verbatim", async () => {
		const { client, prepared } = recordingClient();
		await client.query("SELECT $1, $body$ keep $2 $body$ AS b", ["a", "b"]);
		expect(lastNonPragma(prepared)).toBe(
			"SELECT ?1, $body$ keep $2 $body$ AS b",
		);
	});

	it("still converts $n when a $$ region is never closed", async () => {
		const { client, prepared } = recordingClient();
		await client.query("SELECT $$ open $1, id = $1", ["a"]);
		expect(lastNonPragma(prepared)).toBe("SELECT $$ open ?1, id = ?1");
	});
});

describe("sqlite REGEXP catastrophic-backtracking guard", () => {
	// Long enough that an exponential pattern would take far longer than the
	// test timeout if it ever reached the regex engine.
	const evilValue = `${"a".repeat(30)}!`;

	it("rejects nested-quantifier patterns on the regexp operator", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await expect(
			client.query("SELECT ? REGEXP ? AS m", [evilValue, "(a+)+$"]),
		).rejects.toThrow(/unsafeAllowRegex/);
		db.close();
	});

	it("keeps the connection usable and benign patterns matching", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await expect(
			client.query("SELECT ? REGEXP ? AS m", [evilValue, "(a+)+$"]),
		).rejects.toThrow();
		const ok = await client.query("SELECT 1 AS ok");
		expect(ok.rows[0]?.ok).toBe(1);
		const benign = await client.query("SELECT ? REGEXP ? AS m", [
			"hello",
			"^h",
		]);
		expect(benign.rows[0]?.m).toBe(1);
		db.close();
	});

	it("guards regexp_i as well as regexp", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await expect(
			client.query("SELECT regexp_i(?, ?) AS m", ["(a+)+$", evilValue]),
		).rejects.toThrow(/unsafeAllowRegex/);
		db.close();
	});

	it("allows catastrophic patterns when unsafeAllowRegex is set", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db, { unsafeAllowRegex: true });
		// Short non-matching value so the allowed pattern finishes instantly.
		const result = await client.query("SELECT ? REGEXP ? AS m", [
			"b",
			"(a+)+$",
		]);
		expect(result.rows[0]?.m).toBe(0);
		db.close();
	});

	it("re-registers the guard when the option changes on a shared handle", async () => {
		const db = new DatabaseSync(":memory:");
		const guarded = sqliteClient(db);
		await expect(
			guarded.query("SELECT ? REGEXP ? AS m", [evilValue, "(a+)+$"]),
		).rejects.toThrow();
		const unsafe = sqliteClient(db, { unsafeAllowRegex: true });
		expect(unsafe).toBe(guarded);
		const allowed = await unsafe.query("SELECT ? REGEXP ? AS m", [
			"b",
			"(a+)+$",
		]);
		expect(allowed.rows[0]?.m).toBe(0);
		db.close();
	});
});
