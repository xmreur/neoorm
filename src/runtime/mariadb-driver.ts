import { createRequire } from "node:module";
import type { DatabaseClient, DriverResult } from "./driver.js";
import { NeoOrmDriverError } from "./errors.js";
import {
	type MysqlFamilyPoolOptions,
	toMariadbPoolConfig,
} from "./mysql-family-pool.js";
import { convertNumberedToPositional } from "./mysql-placeholders.js";
import {
	assertNoSavepointOptions,
	buildMysqlBeginStatements,
	buildSavepointName,
	rollbackIgnoringFailure,
} from "./transaction.js";
import type { TransactionOptions } from "./types.js";

export type MariadbQueryResult =
	| unknown[]
	| {
			affectedRows?: number;
			insertId?: number | bigint;
	  };

type MariadbQueryFn = (
	sql: string,
	values?: unknown[],
) => Promise<MariadbQueryResult>;

export type MariadbConnectionLike = {
	query: MariadbQueryFn;
	execute?: MariadbQueryFn;
	release(): void;
};

export type MariadbPoolLike = {
	query: MariadbQueryFn;
	execute?: MariadbQueryFn;
	getConnection(): Promise<MariadbConnectionLike>;
	end(): Promise<void>;
};

export const MARIADB_PEER_MISSING =
	"mariadb is not installed. Run: bun add mariadb";

export function createMariadbPoolFromUrl(
	url: string,
	pool?: MysqlFamilyPoolOptions,
): MariadbPoolLike {
	let createPool: (
		config: ReturnType<typeof toMariadbPoolConfig>,
	) => MariadbPoolLike;
	try {
		const mariadb = createRequire(import.meta.url)("mariadb") as {
			createPool: (
				config: ReturnType<typeof toMariadbPoolConfig>,
			) => MariadbPoolLike;
		};
		createPool = mariadb.createPool;
	} catch {
		throw new Error(MARIADB_PEER_MISSING);
	}
	return createPool(toMariadbPoolConfig(url, pool));
}

function toDriverResult<T>(payload: MariadbQueryResult): DriverResult<T> {
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

function hasReturningClause(sql: string): boolean {
	return /\bRETURNING\b/i.test(sql);
}

const BULK_VALUES = /\bVALUES\s*\([^)]*\)\s*,\s*\(/i;
const SINGLETON_VALUES = /\bVALUES\s*\(/i;
const LEADING_DML = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

type MariadbPreparedDmlKind = "insert" | "update" | "delete" | "replace";

function usesMariadbPreparedExecute(sql: string): boolean {
	// COM_STMT_PREPARE rejects UPDATE/DELETE … RETURNING (ER_PARSE_ERROR).
	if (hasReturningClause(sql)) {
		return false;
	}
	const match = LEADING_DML.exec(sql);
	if (!match) {
		return false;
	}
	const kind = match[1]!.toLowerCase() as MariadbPreparedDmlKind;
	switch (kind) {
		case "insert":
		case "replace":
			return SINGLETON_VALUES.test(sql) && !BULK_VALUES.test(sql);
		case "update":
		case "delete":
			return true;
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}

function mariadbDataQuery(
	client: {
		query: MariadbQueryFn;
		execute?: MariadbQueryFn;
	},
	sql: string,
): MariadbQueryFn {
	if (!client.execute || !usesMariadbPreparedExecute(sql)) {
		return client.query.bind(client);
	}
	return client.execute.bind(client);
}

async function runMariadbQuery<T>(
	client: {
		query: MariadbQueryFn;
		execute?: MariadbQueryFn;
	},
	text: string,
	params: unknown[],
): Promise<DriverResult<T>> {
	const converted = convertNumberedToPositional(text, params);
	try {
		const payload = await mariadbDataQuery(client, converted.sql)(
			converted.sql,
			converted.params,
		);
		return toDriverResult<T>(payload);
	} catch (err) {
		throw new NeoOrmDriverError(text, err);
	}
}

type MariadbTxState = {
	connection: MariadbConnectionLike;
	savepointCounter: number;
	txClient?: DatabaseClient;
};

function getMariadbTxClient(state: MariadbTxState): DatabaseClient {
	if (state.txClient) return state.txClient;
	const txClient: DatabaseClient = {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<DriverResult<T>> {
			return runMariadbQuery(state.connection, text, params);
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
				const result = await fn(txClient);
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
	state.txClient = txClient;
	return txClient;
}

export function mariadbClient(
	pool: MariadbPoolLike,
	options?: { ownsPool?: boolean },
): DatabaseClient {
	return {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<DriverResult<T>> {
			return runMariadbQuery(pool, text, params);
		},
		async transaction<T>(
			fn: (client: DatabaseClient) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			const connection = await pool.getConnection();
			const state: MariadbTxState = { connection, savepointCounter: 0 };
			try {
				for (const stmt of buildMysqlBeginStatements(options)) {
					await connection.query(stmt);
				}
				const result = await fn(getMariadbTxClient(state));
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
