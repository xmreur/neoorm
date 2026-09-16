import { createRequire } from "node:module";
import type { DatabaseClient, DriverResult } from "./driver.js";
import { NeoOrmDriverError } from "./errors.js";
import { convertNumberedToPositional } from "./mysql-placeholders.js";
import {
	assertNoSavepointOptions,
	buildMysqlBeginStatements,
	buildSavepointName,
	rollbackIgnoringFailure,
} from "./transaction.js";
import type { TransactionOptions } from "./types.js";

export type MysqlQueryResult =
	| unknown[]
	| {
			affectedRows?: number;
			insertId?: number | bigint;
	  };

export type MysqlConnectionLike = {
	query(
		sql: string,
		values?: unknown[],
	): Promise<[MysqlQueryResult, unknown]>;
	release(): void;
};

export type MysqlPoolLike = {
	query(
		sql: string,
		values?: unknown[],
	): Promise<[MysqlQueryResult, unknown]>;
	getConnection(): Promise<MysqlConnectionLike>;
	end(): Promise<void>;
};

export const MYSQL2_PEER_MISSING =
	"mysql2 is not installed. Run: bun add mysql2";

export function createMysqlPoolFromUrl(url: string): MysqlPoolLike {
	try {
		const mysql = createRequire(import.meta.url)("mysql2/promise") as {
			createPool: (config: string) => MysqlPoolLike;
		};
		return mysql.createPool(url);
	} catch {
		throw new Error(MYSQL2_PEER_MISSING);
	}
}

function toDriverResult<T>(payload: MysqlQueryResult): DriverResult<T> {
	if (Array.isArray(payload)) {
		return {
			rows: payload as T[],
			rowCount: payload.length,
		};
	}
	return {
		rows: [],
		rowCount: payload.affectedRows ?? 0,
		...(payload.insertId !== undefined && payload.insertId !== 0
			? { insertId: payload.insertId }
			: {}),
	};
}

async function runMysqlQuery<T>(
	query: MysqlPoolLike["query"],
	text: string,
	params: unknown[],
): Promise<DriverResult<T>> {
	const converted = convertNumberedToPositional(text, params);
	try {
		const [payload] = await query(converted.sql, converted.params);
		return toDriverResult<T>(payload);
	} catch (err) {
		throw new NeoOrmDriverError(text, err);
	}
}

type MysqlTxState = {
	connection: MysqlConnectionLike;
	savepointCounter: number;
};

function createMysqlTxClient(state: MysqlTxState): DatabaseClient {
	return {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<DriverResult<T>> {
			return runMysqlQuery(
				state.connection.query.bind(state.connection),
				text,
				params,
			);
		},
		async transaction<T>(
			fn: (client: DatabaseClient) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			assertNoSavepointOptions(options);
			const savepointId = ++state.savepointCounter;
			const name = buildSavepointName(savepointId);
			await state.connection.query(`SAVEPOINT ${name}`);
			try {
				const result = await fn(createMysqlTxClient(state));
				await state.connection.query(`RELEASE SAVEPOINT ${name}`);
				return result;
			} catch (err) {
				await rollbackIgnoringFailure(async () => {
					await state.connection.query(
						`ROLLBACK TO SAVEPOINT ${name}`,
					);
					await state.connection.query(`RELEASE SAVEPOINT ${name}`);
				});
				throw err;
			}
		},
		async close(): Promise<void> {},
	};
}

export function mysqlClient(
	pool: MysqlPoolLike,
	options?: { ownsPool?: boolean },
): DatabaseClient {
	return {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<DriverResult<T>> {
			return runMysqlQuery(pool.query.bind(pool), text, params);
		},
		async transaction<T>(
			fn: (client: DatabaseClient) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			const connection = await pool.getConnection();
			const state: MysqlTxState = { connection, savepointCounter: 0 };
			try {
				for (const stmt of buildMysqlBeginStatements(options)) {
					await connection.query(stmt);
				}
				const result = await fn(createMysqlTxClient(state));
				await connection.query("COMMIT");
				return result;
			} catch (err) {
				await rollbackIgnoringFailure(() =>
					connection.query("ROLLBACK"),
				);
				throw err;
			} finally {
				connection.release();
			}
		},
		async close(): Promise<void> {
			if (options?.ownsPool) {
				await pool.end();
			}
		},
	};
}
