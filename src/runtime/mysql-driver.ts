import { createRequire } from "node:module";
import type { DatabaseClient, DriverResult } from "./driver.js";
import { NeoOrmDriverError } from "./errors.js";
import {
	type MysqlFamilyPoolOptions,
	toMysql2PoolConfig,
} from "./mysql-family-pool.js";
import { convertNumberedToPositional } from "./mysql-placeholders.js";
import {
	assertNoSavepointOptions,
	assertSavepointStackOpen,
	buildMysqlBeginStatements,
	buildSavepointName,
	rollbackIgnoringFailure,
	runInSavepoint,
} from "./transaction.js";
import type { TransactionOptions } from "./types.js";

export type MysqlQueryResult =
	| unknown[]
	| {
			affectedRows?: number;
			insertId?: number | bigint;
	  };

type MysqlQueryFn = (
	sql: string,
	values?: unknown[],
) => Promise<[MysqlQueryResult, unknown]>;

export type MysqlConnectionLike = {
	query: MysqlQueryFn;
	execute?: MysqlQueryFn;
	release(): void;
};

export type MysqlPoolLike = {
	query: MysqlQueryFn;
	execute?: MysqlQueryFn;
	getConnection(): Promise<MysqlConnectionLike>;
	end(): Promise<void>;
};

export const MYSQL2_PEER_MISSING =
	"mysql2 is not installed. Run: bun add mysql2";

export function createMysqlPoolFromUrl(
	url: string,
	pool?: MysqlFamilyPoolOptions,
): MysqlPoolLike {
	let createPool: (
		config: ReturnType<typeof toMysql2PoolConfig>,
	) => MysqlPoolLike;
	try {
		const mysql = createRequire(import.meta.url)("mysql2/promise") as {
			createPool: (
				config: ReturnType<typeof toMysql2PoolConfig>,
			) => MysqlPoolLike;
		};
		createPool = mysql.createPool;
	} catch {
		throw new Error(MYSQL2_PEER_MISSING);
	}
	// Outside the peer-missing try: a bad URL/config thrown by mysql2 must
	// surface as itself, not be misreported as "mysql2 is not installed".
	return createPool(toMysql2PoolConfig(url, pool));
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

function mysqlDataQuery(client: {
	query: MysqlQueryFn;
	execute?: MysqlQueryFn;
}): MysqlQueryFn {
	return client.execute?.bind(client) ?? client.query.bind(client);
}

async function runMysqlQuery<T>(
	query: MysqlQueryFn,
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
	poisoned: boolean;
	txClient?: DatabaseClient;
};

function getMysqlTxClient(state: MysqlTxState): DatabaseClient {
	if (state.txClient) return state.txClient;
	const txClient: DatabaseClient = {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<DriverResult<T>> {
			assertSavepointStackOpen(state.poisoned);
			return runMysqlQuery(
				mysqlDataQuery(state.connection),
				text,
				params,
			);
		},
		async transaction<T>(
			fn: (client: DatabaseClient) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			assertNoSavepointOptions(options);
			assertSavepointStackOpen(state.poisoned);
			const savepointId = ++state.savepointCounter;
			const name = buildSavepointName(savepointId);
			return runInSavepoint(
				(sql) => state.connection.query(sql),
				name,
				() => fn(txClient),
				() => {
					state.poisoned = true;
				},
			);
		},
		async close(): Promise<void> {},
	};
	state.txClient = txClient;
	return txClient;
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
			return runMysqlQuery(mysqlDataQuery(pool), text, params);
		},
		async transaction<T>(
			fn: (client: DatabaseClient) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			const connection = await pool.getConnection();
			const state: MysqlTxState = {
				connection,
				savepointCounter: 0,
				poisoned: false,
			};
			try {
				for (const stmt of buildMysqlBeginStatements(options)) {
					await connection.query(stmt);
				}
				const result = await fn(getMysqlTxClient(state));
				assertSavepointStackOpen(state.poisoned);
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
