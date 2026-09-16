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

export type MariadbQueryResult =
	| unknown[]
	| {
			affectedRows?: number;
			insertId?: number | bigint;
	  };

export type MariadbConnectionLike = {
	query(sql: string, values?: unknown[]): Promise<MariadbQueryResult>;
	release(): void;
};

export type MariadbPoolLike = {
	query(sql: string, values?: unknown[]): Promise<MariadbQueryResult>;
	getConnection(): Promise<MariadbConnectionLike>;
	end(): Promise<void>;
};

export const MARIADB_PEER_MISSING =
	"mariadb is not installed. Run: bun add mariadb";

function parseMariadbUrl(url: string): {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
} {
	const parsed = new URL(url);
	return {
		host: parsed.hostname || "localhost",
		port: parsed.port ? Number(parsed.port) : 3306,
		user: decodeURIComponent(parsed.username),
		password: decodeURIComponent(parsed.password),
		database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
	};
}

type MariadbPoolConfig = {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
};

export function createMariadbPoolFromUrl(url: string): MariadbPoolLike {
	let createPool: (config: MariadbPoolConfig) => MariadbPoolLike;
	try {
		const mariadb = createRequire(import.meta.url)("mariadb") as {
			createPool: (config: MariadbPoolConfig) => MariadbPoolLike;
		};
		createPool = mariadb.createPool;
	} catch {
		throw new Error(MARIADB_PEER_MISSING);
	}
	return createPool(parseMariadbUrl(url));
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

async function runMariadbQuery<T>(
	query: (sql: string, values?: unknown[]) => Promise<MariadbQueryResult>,
	text: string,
	params: unknown[],
): Promise<DriverResult<T>> {
	const converted = convertNumberedToPositional(text, params);
	try {
		const payload = await query(converted.sql, converted.params);
		return toDriverResult<T>(payload);
	} catch (err) {
		throw new NeoOrmDriverError(text, err);
	}
}

type MariadbTxState = {
	connection: MariadbConnectionLike;
	savepointCounter: number;
};

function createMariadbTxClient(state: MariadbTxState): DatabaseClient {
	return {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<DriverResult<T>> {
			return runMariadbQuery(
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
				const result = await fn(createMariadbTxClient(state));
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

export function mariadbClient(
	pool: MariadbPoolLike,
	options?: { ownsPool?: boolean },
): DatabaseClient {
	return {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<DriverResult<T>> {
			return runMariadbQuery(pool.query.bind(pool), text, params);
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
				const result = await fn(createMariadbTxClient(state));
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
