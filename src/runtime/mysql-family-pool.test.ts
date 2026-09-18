import { describe, expect, it } from "vitest";
import { mariadbClient } from "./mariadb-driver.js";
import { type MysqlQueryResult, mysqlClient } from "./mysql-driver.js";
import {
	MARIADB_PREPARE_CACHE_LENGTH,
	toMariadbPoolConfig,
	toMysql2PoolConfig,
} from "./mysql-family-pool.js";

describe("toMysql2PoolConfig", () => {
	it("defaults to connectionLimit 10, keep-alive, and waitForConnections", () => {
		expect(toMysql2PoolConfig("mysql://root@localhost/db")).toEqual({
			uri: "mysql://root@localhost/db",
			connectionLimit: 10,
			waitForConnections: true,
			queueLimit: 0,
			enableKeepAlive: true,
			keepAliveInitialDelay: 0,
		});
	});

	it("maps shared NeoOrm pool fields", () => {
		expect(
			toMysql2PoolConfig("mysql://root@localhost/db", {
				max: 8,
				idleTimeoutMillis: 15_000,
				connectionTimeoutMillis: 4_000,
				keepAlive: false,
				keepAliveInitialDelayMillis: 50,
			}),
		).toEqual({
			uri: "mysql://root@localhost/db",
			connectionLimit: 8,
			waitForConnections: true,
			queueLimit: 0,
			enableKeepAlive: false,
			keepAliveInitialDelay: 50,
			idleTimeout: 15_000,
			connectTimeout: 4_000,
		});
	});
});

describe("toMariadbPoolConfig", () => {
	it("enables pipelining and a prepare cache", () => {
		expect(toMariadbPoolConfig("mariadb://u:p@dbhost:3307/app")).toEqual({
			host: "dbhost",
			port: 3307,
			user: "u",
			password: "p",
			database: "app",
			connectionLimit: 10,
			pipelining: true,
			prepareCacheLength: MARIADB_PREPARE_CACHE_LENGTH,
			keepAliveDelay: 0,
		});
	});

	it("converts idleTimeoutMillis to seconds", () => {
		const config = toMariadbPoolConfig("mariadb://root@localhost/db", {
			max: 4,
			min: 1,
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 2_000,
			keepAlive: false,
		});
		expect(config.connectionLimit).toBe(4);
		expect(config.minimumIdle).toBe(1);
		expect(config.idleTimeout).toBe(30);
		expect(config.acquireTimeout).toBe(2_000);
		expect(config.keepAliveDelay).toBeUndefined();
	});
});

describe("mysqlClient execute vs query", () => {
	it("uses execute for data queries and query for transaction control", async () => {
		const calls: Array<{ op: string; sql: string }> = [];
		const connection = {
			async query(sql: string): Promise<[MysqlQueryResult, unknown]> {
				calls.push({ op: "query", sql });
				return [{ affectedRows: 0 }, undefined];
			},
			async execute(sql: string): Promise<[MysqlQueryResult, unknown]> {
				calls.push({ op: "execute", sql });
				return [[{ id: 1 }], undefined];
			},
			release() {},
		};
		const pool = {
			async query(sql: string): Promise<[MysqlQueryResult, unknown]> {
				calls.push({ op: "query", sql });
				return [[{ id: 1 }], undefined];
			},
			async execute(sql: string): Promise<[MysqlQueryResult, unknown]> {
				calls.push({ op: "execute", sql });
				return [[{ id: 1 }], undefined];
			},
			async getConnection() {
				return connection;
			},
			async end() {},
		};

		const client = mysqlClient(pool);
		await client.query("SELECT * FROM t WHERE id = $1", [1]);
		await client.transaction(async (tx) => {
			await tx.query("SELECT 1");
		});

		expect(
			calls.filter((c) => c.op === "execute").map((c) => c.sql),
		).toEqual(["SELECT * FROM t WHERE id = ?", "SELECT 1"]);
		expect(calls.filter((c) => c.op === "query").map((c) => c.sql)).toEqual(
			["START TRANSACTION", "COMMIT"],
		);
		expect(
			calls.some(
				(c) =>
					c.sql.includes("SET TRANSACTION") ||
					c.sql.includes("SAVEPOINT"),
			),
		).toBe(false);
	});

	it("prepends SET TRANSACTION only when isolationLevel is set", async () => {
		const sqls: string[] = [];
		const connection = {
			async query(sql: string): Promise<[MysqlQueryResult, unknown]> {
				sqls.push(sql);
				return [{ affectedRows: 0 }, undefined];
			},
			release() {},
		};
		const pool = {
			async query(sql: string): Promise<[MysqlQueryResult, unknown]> {
				sqls.push(sql);
				return [[{ id: 1 }], undefined];
			},
			async getConnection() {
				return connection;
			},
			async end() {},
		};

		const client = mysqlClient(pool);
		await client.transaction(async () => "ok", {
			isolationLevel: "Serializable",
		});

		expect(sqls).toEqual([
			"SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
			"START TRANSACTION",
			"COMMIT",
		]);
		expect(sqls.some((sql) => sql.includes("SAVEPOINT"))).toBe(false);
	});

	it("reuses one tx client and emits SAVEPOINT only for nested transaction()", async () => {
		const sqls: string[] = [];
		const connection = {
			async query(sql: string): Promise<[MysqlQueryResult, unknown]> {
				sqls.push(sql);
				return [{ affectedRows: 0 }, undefined];
			},
			async execute(sql: string): Promise<[MysqlQueryResult, unknown]> {
				sqls.push(sql);
				return [[{ id: 1 }], undefined];
			},
			release() {},
		};
		const pool = {
			async query(): Promise<[MysqlQueryResult, unknown]> {
				return [[{ id: 1 }], undefined];
			},
			async getConnection() {
				return connection;
			},
			async end() {},
		};

		const client = mysqlClient(pool);
		await client.transaction(async (tx) => {
			await tx.transaction(async (inner) => {
				expect(inner).toBe(tx);
			});
		});

		expect(sqls).toEqual([
			"START TRANSACTION",
			"SAVEPOINT neoorm_sp_1",
			"RELEASE SAVEPOINT neoorm_sp_1",
			"COMMIT",
		]);
	});

	it("falls back to query when execute is missing", async () => {
		const sqls: string[] = [];
		const pool = {
			async query(sql: string): Promise<[MysqlQueryResult, unknown]> {
				sqls.push(sql);
				return [[{ ok: 1 }], undefined];
			},
			async getConnection() {
				return {
					query: pool.query,
					release() {},
				};
			},
			async end() {},
		};

		const client = mysqlClient(pool);
		await client.query("SELECT $1", ["x"]);
		expect(sqls).toEqual(["SELECT ?"]);
	});
});

describe("mariadbClient execute vs query", () => {
	it("uses query for reads, execute for singleton writes, and query for transaction control", async () => {
		const calls: Array<{ op: string; sql: string }> = [];
		const connection = {
			async query(sql: string) {
				calls.push({ op: "query", sql });
				return { affectedRows: 0 };
			},
			async execute(sql: string) {
				calls.push({ op: "execute", sql });
				return [{ id: 1 }];
			},
			release() {},
		};
		const pool = {
			async query(sql: string) {
				calls.push({ op: "query", sql });
				return [{ id: 1 }];
			},
			async execute(sql: string) {
				calls.push({ op: "execute", sql });
				return [{ id: 1 }];
			},
			async getConnection() {
				return connection;
			},
			async end() {},
		};

		const client = mariadbClient(pool);
		await client.query("SELECT * FROM t WHERE id = $1", [1]);
		await client.transaction(async (tx) => {
			await tx.query("INSERT INTO t (v) VALUES ($1)", ["x"]);
			await tx.transaction(async (inner) => {
				expect(inner).toBe(tx);
				await inner.query("SELECT 2");
			});
		});

		expect(
			calls.filter((c) => c.op === "execute").map((c) => c.sql),
		).toEqual(["INSERT INTO t (v) VALUES (?)"]);
		expect(calls.filter((c) => c.op === "query").map((c) => c.sql)).toEqual(
			[
				"SELECT * FROM t WHERE id = ?",
				"START TRANSACTION",
				"SAVEPOINT neoorm_sp_1",
				"SELECT 2",
				"RELEASE SAVEPOINT neoorm_sp_1",
				"COMMIT",
			],
		);
	});

	it("default outer transaction is START TRANSACTION then COMMIT", async () => {
		const sqls: string[] = [];
		const connection = {
			async query(sql: string) {
				sqls.push(sql);
				return { affectedRows: 0 };
			},
			release() {},
		};
		const pool = {
			async query() {
				return [{ id: 1 }];
			},
			async getConnection() {
				return connection;
			},
			async end() {},
		};

		const client = mariadbClient(pool);
		await client.transaction(async (tx) => {
			await tx.transaction(async (inner) => {
				expect(inner).toBe(tx);
			});
		});

		expect(sqls.filter((sql) => !sql.includes("SAVEPOINT"))).toEqual([
			"START TRANSACTION",
			"COMMIT",
		]);
		expect(sqls.some((sql) => sql.includes("SET TRANSACTION"))).toBe(false);
	});

	it("uses query for RETURNING because prepare rejects UPDATE RETURNING", async () => {
		const calls: Array<{ op: string; sql: string }> = [];
		const pool = {
			async query(sql: string) {
				calls.push({ op: "query", sql });
				return [{ id: 1, age: 31 }];
			},
			async execute(sql: string) {
				calls.push({ op: "execute", sql });
				return [{ id: 1, age: 31 }];
			},
			async getConnection() {
				return {
					query: pool.query,
					execute: pool.execute,
					release() {},
				};
			},
			async end() {},
		};

		const client = mariadbClient(pool);
		await client.query(
			"UPDATE `users` SET `age` = $1 WHERE `id` = $2 RETURNING `id`, `age`",
			[31, 1],
		);

		expect(calls.map((c) => c.op)).toEqual(["query"]);
		expect(calls[0]?.sql).toContain("RETURNING");
		expect(calls[0]?.sql).not.toMatch(/\$\d/);
	});

	it("uses query for bulk VALUES so unique arities do not occupy the prepare cache", async () => {
		const calls: Array<{ op: string; sql: string }> = [];
		const pool = {
			async query(sql: string) {
				calls.push({ op: "query", sql });
				return { affectedRows: 2 };
			},
			async execute(sql: string) {
				calls.push({ op: "execute", sql });
				return { affectedRows: 2 };
			},
			async getConnection() {
				return {
					query: pool.query,
					execute: pool.execute,
					release() {},
				};
			},
			async end() {},
		};

		const client = mariadbClient(pool);
		await client.query("INSERT INTO t (v) VALUES ($1), ($2)", ["a", "b"]);
		await client.query("INSERT INTO t SELECT v FROM src");

		expect(calls.map((c) => c.op)).toEqual(["query", "query"]);
	});

	it("uses execute for singleton UPDATE and DELETE without RETURNING", async () => {
		const calls: Array<{ op: string; sql: string }> = [];
		const pool = {
			async query(sql: string) {
				calls.push({ op: "query", sql });
				return { affectedRows: 1 };
			},
			async execute(sql: string) {
				calls.push({ op: "execute", sql });
				return { affectedRows: 1 };
			},
			async getConnection() {
				return {
					query: pool.query,
					execute: pool.execute,
					release() {},
				};
			},
			async end() {},
		};

		const client = mariadbClient(pool);
		await client.query(
			"UPDATE `users` SET `age` = $1 WHERE `id` = $2",
			[31, 1],
		);
		await client.query("DELETE FROM `users` WHERE `id` = $1", [1]);

		expect(calls.map((c) => c.op)).toEqual(["execute", "execute"]);
	});
});
