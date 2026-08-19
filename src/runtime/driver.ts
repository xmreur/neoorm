import type { Pool, PoolClient, QueryResult } from "pg";
import { buildBeginSql } from "./transaction.js";
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
	run(
		...params: unknown[]
	): {
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
while (i + 1 < sql.length && /\d/.test(sql[i + 1] ?? "")) {
			i++;
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

export function sqliteClient(db: SqliteDatabaseLike): DatabaseClient {
	db.exec("PRAGMA foreign_keys = ON");
	const state = { txDepth: 0, savepointCounter: 0 };

	const client: DatabaseClient = {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<DriverResult<T>> {
			const sql = convertPlaceholders(text);

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

			try {
				const result = db.prepare(sql).run();
				return {
					rows: [],
					rowCount: Number(result.changes),
				} as DriverResult<T>;
			} catch {
				db.exec(sql);
				return { rows: [], rowCount: 0 } as DriverResult<T>;
			}
		},

		async transaction<T>(
			fn: (client: DatabaseClient) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			if (state.txDepth > 0) {
				if (
					options?.readOnly !== undefined ||
					options?.isolationLevel !== undefined
				) {
					throw new Error(
						"Transaction options (readOnly, isolationLevel) cannot be used with nested transactions",
					);
				}
				const savepointId = ++state.savepointCounter;
				const name = `neoorm_sp_${savepointId}`;
				db.exec(`SAVEPOINT ${name}`);
				try {
					state.txDepth++;
					const result = await fn(client);
					db.exec(`RELEASE SAVEPOINT ${name}`);
					return result;
				} catch (err) {
					db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
					db.exec(`RELEASE SAVEPOINT ${name}`);
					throw err;
				} finally {
					state.txDepth--;
				}
			}

			db.exec(buildSqliteBeginSql(options));
			try {
				state.txDepth++;
				const result = await fn(client);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			} finally {
				state.txDepth--;
			}
		},

		async close(): Promise<void> {
			db.close();
		},
	};

	return client;
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
			const result: QueryResult = await state.client.query(text, params);
			return {
				rows: result.rows as T[],
				rowCount: result.rowCount ?? 0,
			};
		},
		async transaction<T>(
			fn: (client: DatabaseClient) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			if (
				options?.readOnly !== undefined ||
				options?.isolationLevel !== undefined
			) {
				throw new Error(
					"Transaction options (readOnly, isolationLevel) cannot be used with nested transactions",
				);
			}
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
			const result: QueryResult = await pool.query(text, params);
			return {
				rows: result.rows as T[],
				rowCount: result.rowCount ?? 0,
			};
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