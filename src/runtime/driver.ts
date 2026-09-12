import type { Pool, PoolClient, QueryResult } from "pg";
import { NeoOrmDriverError } from "./errors.js";
import { assertNoSavepointOptions, buildBeginSql } from "./transaction.js";
import type { TransactionOptions } from "./types.js";

export type DriverResult<T = Record<string, unknown>> = {
	rows: T[];
	rowCount: number;
};

export type DatabaseClient = {
	query<T = Record<string, unknown>>(
		text: string,
		params?: unknown[],
	): Promise<DriverResult<T>>;
	transaction<T>(
		fn: (client: DatabaseClient) => Promise<T>,
		options?: TransactionOptions,
	): Promise<T>;
	close(): Promise<void>;
};

type SqliteStatement = {
	all(...params: unknown[]): Record<string, unknown>[];
	get(...params: unknown[]): Record<string, unknown> | undefined;
	run(...params: unknown[]): {
		changes: number | bigint;
		lastInsertRowid: number | bigint;
	};
};

export type SqliteDatabaseLike = {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
	close(): void;
};

function convertPlaceholders(sql: string): string {
	let out = "";
	let inSingle = false;
	let inDouble = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const next = sql[i + 1];

		if (inLineComment) {
			out += ch;
			if (ch === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			out += ch;
			if (ch === "*" && next === "/") {
				out += next;
				i++;
				inBlockComment = false;
			}
			continue;
		}
		if (inSingle) {
			out += ch;
			if (ch === "'") {
				if (next === "'") {
					out += next;
					i++;
				} else {
					inSingle = false;
				}
			}
			continue;
		}
		if (inDouble) {
			out += ch;
			if (ch === '"') {
				if (next === '"') {
					out += next;
					i++;
				} else {
					inDouble = false;
				}
			}
			continue;
		}
		if (ch === "-" && next === "-") {
			inLineComment = true;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			out += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			out += ch;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			out += ch;
			continue;
		}
		if (ch === "$" && next !== undefined && /\d/.test(next)) {
			out += "?";
			i++;
			out += next;
			while (i + 1 < sql.length && /\d/.test(sql[i + 1] ?? "")) {
				i++;
				out += sql[i];
			}
			continue;
		}
		out += ch;
	}

	return out;
}

function isReadStatement(sql: string): boolean {
	return /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql);
}

function serializeParam(value: unknown): unknown {
	if (value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value instanceof Date) return value.toISOString();
	if (
		typeof value === "object" &&
		value !== null &&
		!(value instanceof Uint8Array)
	) {
		return JSON.stringify(value);
	}
	return value;
}

function sqliteRows(result: Record<string, unknown>[]): DriverResult {
	return { rows: result, rowCount: result.length };
}

function splitStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const next = sql[i + 1];

		if (inLineComment) {
			current += ch;
			if (ch === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			current += ch;
			if (ch === "*" && next === "/") {
				current += next;
				i++;
				inBlockComment = false;
			}
			continue;
		}
		if (inSingle) {
			current += ch;
			if (ch === "'") {
				if (next === "'") {
					current += next;
					i++;
				} else {
					inSingle = false;
				}
			}
			continue;
		}
		if (inDouble) {
			current += ch;
			if (ch === '"') {
				if (next === '"') {
					current += next;
					i++;
				} else {
					inDouble = false;
				}
			}
			continue;
		}
		if (ch === "-" && next === "-") {
			inLineComment = true;
			current += ch;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			current += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			current += ch;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			current += ch;
			continue;
		}
		if (ch === ";") {
			if (current.trim().length > 0) {
				statements.push(current.trim());
			}
			current = "";
			continue;
		}
		current += ch;
	}

	if (current.trim().length > 0) {
		statements.push(current.trim());
	}

	return statements.length > 0 ? statements : [sql];
}

async function executeWriteStatements(
	db: SqliteDatabaseLike,
	sql: string,
): Promise<DriverResult> {
	const statements = splitStatements(sql);
	let changes = 0;

	for (const statement of statements) {
		try {
			const result = db.prepare(statement).run();
			changes += Number(result.changes);
		} catch (prepareErr) {
			try {
				db.exec(statement);
			} catch (execErr) {
				throw new NeoOrmDriverError(statement, execErr ?? prepareErr);
			}
		}
	}

	return { rows: [], rowCount: changes };
}

const sqliteClients = new WeakMap<SqliteDatabaseLike, DatabaseClient>();

export function sqliteClient(db: SqliteDatabaseLike): DatabaseClient {
	const cached = sqliteClients.get(db);
	if (cached) {
		return cached;
	}
	const client = createSqliteClient(db);
	sqliteClients.set(db, client);
	return client;
}

function createSqliteClient(db: SqliteDatabaseLike): DatabaseClient {
	db.exec("PRAGMA foreign_keys = ON");
	const state = { savepointCounter: 0 };

	// One SQLite connection is shared by every query and transaction.
	// A FIFO mutex serializes all outer access so a concurrent findMany/create
	// cannot join an open BEGIN. Transaction callbacks receive an inner client
	// that skips the mutex (they already hold it); nested transactions use
	// savepoints on that inner client.
	let gate: Promise<unknown> = Promise.resolve();

	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = gate.then(work, work);
		gate = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async function runQuery<T = Record<string, unknown>>(
		text: string,
		params: unknown[] = [],
	): Promise<DriverResult<T>> {
		const sql = convertPlaceholders(text);
		try {
			if (params.length > 0) {
				const stmt = db.prepare(sql);
				const values = params.map(serializeParam);
				if (isReadStatement(sql)) {
					return sqliteRows(stmt.all(...values)) as DriverResult<T>;
				}
				if (/\bRETURNING\b/i.test(sql)) {
					const rows = stmt.all(...values);
					return sqliteRows(rows) as DriverResult<T>;
				}
				const result = stmt.run(...values);
				return {
					rows: [],
					rowCount: Number(result.changes),
				} as DriverResult<T>;
			}

			if (isReadStatement(sql)) {
				return sqliteRows(db.prepare(sql).all()) as DriverResult<T>;
			}

			if (/\bRETURNING\b/i.test(sql)) {
				return sqliteRows(db.prepare(sql).all()) as DriverResult<T>;
			}

			return (await executeWriteStatements(db, sql)) as DriverResult<T>;
		} catch (err) {
			if (err instanceof NeoOrmDriverError) {
				throw err;
			}
			throw new NeoOrmDriverError(sql, err);
		}
	}

	function createTxClient(): DatabaseClient {
		return {
			query: runQuery,
			async transaction<T>(
				fn: (client: DatabaseClient) => Promise<T>,
				options?: TransactionOptions,
			): Promise<T> {
				assertNoSavepointOptions(options);
				const name = `neoorm_sp_${++state.savepointCounter}`;
				db.exec(`SAVEPOINT ${name}`);
				try {
					const result = await fn(createTxClient());
					db.exec(`RELEASE SAVEPOINT ${name}`);
					return result;
				} catch (err) {
					db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
					db.exec(`RELEASE SAVEPOINT ${name}`);
					throw err;
				}
			},
			async close(): Promise<void> {},
		};
	}

	return {
		query: (text, params = []) => enqueue(() => runQuery(text, params)),
		transaction: (fn, options) =>
			enqueue(async () => {
				db.exec(buildSqliteBeginSql(options));
				try {
					const result = await fn(createTxClient());
					db.exec("COMMIT");
					return result;
				} catch (err) {
					try {
						db.exec("ROLLBACK");
					} catch {
						// e.g. the failed COMMIT already rolled back; never mask err.
					}
					throw err;
				}
			}),
		async close(): Promise<void> {
			db.close();
		},
	};
}

function buildSqliteBeginSql(options?: TransactionOptions): string {
	if (options?.readOnly) {
		return "BEGIN DEFERRED";
	}
	switch (options?.isolationLevel) {
		case "RepeatableRead":
		case "Serializable":
			return "BEGIN IMMEDIATE";
		case "ReadUncommitted":
		case "ReadCommitted":
		default:
			return "BEGIN";
	}
}

type PgTxState = {
	client: PoolClient;
	savepointCounter: number;
};

function createPgTxClient(state: PgTxState): DatabaseClient {
	return {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<DriverResult<T>> {
			try {
				const result: QueryResult = await state.client.query(
					text,
					params,
				);
				return {
					rows: result.rows as T[],
					rowCount: result.rowCount ?? 0,
				};
			} catch (err) {
				throw new NeoOrmDriverError(text, err);
			}
		},
		async transaction<T>(
			fn: (client: DatabaseClient) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			assertNoSavepointOptions(options);
			const savepointId = ++state.savepointCounter;
			const name = `neoorm_sp_${savepointId}`;
			await state.client.query(`SAVEPOINT ${name}`);
			try {
				const result = await fn(createPgTxClient(state));
				await state.client.query(`RELEASE SAVEPOINT ${name}`);
				return result;
			} catch (err) {
				await state.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
				await state.client.query(`RELEASE SAVEPOINT ${name}`);
				throw err;
			}
		},
		async close(): Promise<void> {},
	};
}

export function pgClient(pool: Pool): DatabaseClient {
	return {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<DriverResult<T>> {
			try {
				const result: QueryResult = await pool.query(text, params);
				return {
					rows: result.rows as T[],
					rowCount: result.rowCount ?? 0,
				};
			} catch (err) {
				throw new NeoOrmDriverError(text, err);
			}
		},
		async transaction<T>(
			fn: (client: DatabaseClient) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			const client = await pool.connect();
			const state: PgTxState = { client, savepointCounter: 0 };
			try {
				await client.query(buildBeginSql(options));
				const result = await fn(createPgTxClient(state));
				await client.query("COMMIT");
				return result;
			} catch (err) {
				await client.query("ROLLBACK");
				throw err;
			} finally {
				client.release();
			}
		},
		async close(): Promise<void> {
			await pool.end();
		},
	};
}
