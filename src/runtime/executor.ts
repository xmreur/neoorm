import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import type { CompiledQuery } from "../dialect/types.js";
import {
	type DatabaseClient,
	type SqliteDatabaseLike,
	sqliteClient,
} from "./driver.js";
import { CappedMap } from "./query/table-index.js";
import {
	assertNoSavepointOptions,
	buildBeginSql,
	buildSavepointName,
	rollbackIgnoringFailure,
} from "./transaction.js";
import type { TransactionOptions } from "./types.js";

export type ExecuteResult<T = Record<string, unknown>> = {
	rows: T[];
	rowCount: number;
};

export type QueryMethod = "query" | "queryOne" | "execute";

/** Fired immediately before a data query runs (not BEGIN/COMMIT/SAVEPOINT). */
export type QueryEvent = {
	sql: string;
	params: unknown[];
	method: QueryMethod;
	inTransaction: boolean;
};

/** Fired after a data query succeeds or fails. */
export type QueryResultEvent = QueryEvent & {
	durationMs: number;
	rowCount?: number;
	error?: unknown;
};

export type QueryHooks = {
	beforeQuery?: (event: QueryEvent) => void | Promise<void>;
	afterQuery?: (event: QueryResultEvent) => void | Promise<void>;
};

export type Executor = {
	readonly inTransaction?: boolean;
	query<T = Record<string, unknown>>(
		text: string,
		params?: unknown[],
	): Promise<T[]>;
	queryOne<T = Record<string, unknown>>(
		text: string,
		params?: unknown[],
	): Promise<T | null>;
	execute<T = Record<string, unknown>>(
		text: string,
		params?: unknown[],
	): Promise<ExecuteResult<T>>;
	transaction<T>(
		fn: (tx: Executor) => Promise<T>,
		options?: TransactionOptions,
	): Promise<T>;
};

export type ExecutorOptions = {
	preparedStatements?: boolean;
} & QueryHooks;

function hasQueryHooks(hooks: QueryHooks | undefined): hooks is QueryHooks {
	return hooks?.beforeQuery !== undefined || hooks?.afterQuery !== undefined;
}

async function runWithQueryHooks<T>(
	hooks: QueryHooks,
	event: QueryEvent,
	run: () => Promise<{ value: T; rowCount?: number }>,
): Promise<T> {
	await hooks.beforeQuery?.(event);
	const started = performance.now();
	try {
		const { value, rowCount } = await run();
		await hooks.afterQuery?.({
			...event,
			durationMs: performance.now() - started,
			...(rowCount !== undefined ? { rowCount } : {}),
		});
		return value;
	} catch (error) {
		try {
			await hooks.afterQuery?.({
				...event,
				durationMs: performance.now() - started,
				error,
			});
		} catch {
			// Keep the original query error.
		}
		throw error;
	}
}

function wrapQueryMethods(
	methods: Pick<Executor, "query" | "queryOne" | "execute">,
	hooks: QueryHooks | undefined,
	inTransaction: boolean,
): Pick<Executor, "query" | "queryOne" | "execute"> {
	if (!hasQueryHooks(hooks)) return methods;

	return {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<T[]> {
			return runWithQueryHooks(
				hooks,
				{ sql: text, params, method: "query", inTransaction },
				async () => {
					const value = await methods.query<T>(text, params);
					return { value, rowCount: value.length };
				},
			);
		},
		async queryOne<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<T | null> {
			return runWithQueryHooks(
				hooks,
				{ sql: text, params, method: "queryOne", inTransaction },
				async () => {
					const value = await methods.queryOne<T>(text, params);
					return { value, rowCount: value === null ? 0 : 1 };
				},
			);
		},
		async execute<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<ExecuteResult<T>> {
			return runWithQueryHooks(
				hooks,
				{ sql: text, params, method: "execute", inTransaction },
				async () => {
					const value = await methods.execute<T>(text, params);
					return { value, rowCount: value.rowCount };
				},
			);
		},
	};
}

function rowsFromResult(result: QueryResult): Record<string, unknown>[] {
	return result.rows as Record<string, unknown>[];
}

function executeFromResult<T = Record<string, unknown>>(
	result: QueryResult,
): ExecuteResult<T> {
	return {
		rows: rowsFromResult(result) as T[],
		rowCount: result.rowCount ?? 0,
	};
}

type Queryable = Pick<Pool, "query">;

const statementNameCache = new CappedMap<string, string>(500);

function statementName(text: string): string {
	const cached = statementNameCache.get(text);
	if (cached !== undefined) return cached;
	const name = `neoorm_${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
	statementNameCache.set(text, name);
	return name;
}

async function runQuery(
	client: Queryable,
	text: string,
	params: unknown[],
	usePrepared: boolean,
): Promise<QueryResult> {
	if (usePrepared) {
		return client.query({
			name: statementName(text),
			text,
			values: params,
		});
	}
	return client.query(text, params);
}

type TransactionState = {
	client: PoolClient;
	savepointCounter: number;
};

function createQueryMethods(
	client: Queryable,
	usePrepared: boolean,
	hooks: QueryHooks | undefined,
	inTransaction: boolean,
): Pick<Executor, "query" | "queryOne" | "execute"> {
	return wrapQueryMethods(
		{
			async query<T = Record<string, unknown>>(
				text: string,
				params: unknown[] = [],
			): Promise<T[]> {
				const result = await runQuery(
					client,
					text,
					params,
					usePrepared,
				);
				return rowsFromResult(result) as T[];
			},

			async queryOne<T = Record<string, unknown>>(
				text: string,
				params: unknown[] = [],
			): Promise<T | null> {
				const result = await runQuery(
					client,
					text,
					params,
					usePrepared,
				);
				const rows = rowsFromResult(result);
				return (rows[0] as T | undefined) ?? null;
			},

			async execute<T = Record<string, unknown>>(
				text: string,
				params: unknown[] = [],
			): Promise<ExecuteResult<T>> {
				const result = await runQuery(
					client,
					text,
					params,
					usePrepared,
				);
				return executeFromResult<T>(result);
			},
		},
		hooks,
		inTransaction,
	);
}

export function createExecutor(
	pool: Pool,
	options?: ExecutorOptions,
): Executor {
	const usePrepared = options?.preparedStatements ?? false;
	const hooks: QueryHooks | undefined = options;
	const queryMethods = createQueryMethods(pool, usePrepared, hooks, false);

	return {
		...queryMethods,

		async transaction<T>(
			fn: (tx: Executor) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			const client = await pool.connect();
			try {
				await client.query(buildBeginSql(options));
				const state: TransactionState = { client, savepointCounter: 0 };
				const tx = createClientExecutor(state, usePrepared, hooks);
				const result = await fn(tx);
				await client.query("COMMIT");
				return result;
			} catch (err) {
				await rollbackIgnoringFailure(() => client.query("ROLLBACK"));
				throw err;
			} finally {
				client.release();
			}
		},
	};
}

function createClientExecutor(
	state: TransactionState,
	usePrepared: boolean,
	hooks: QueryHooks | undefined,
): Executor {
	const { client } = state;
	const queryMethods = createQueryMethods(client, usePrepared, hooks, true);

	return {
		inTransaction: true,
		...queryMethods,

		async transaction<T>(
			fn: (tx: Executor) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			assertNoSavepointOptions(options);

			const savepointId = ++state.savepointCounter;
			const savepointName = buildSavepointName(savepointId);

			await client.query(`SAVEPOINT ${savepointName}`);
			try {
				const result = await fn(
					createClientExecutor(state, usePrepared, hooks),
				);
				await client.query(`RELEASE SAVEPOINT ${savepointName}`);
				return result;
			} catch (err) {
				await rollbackIgnoringFailure(async () => {
					await client.query(
						`ROLLBACK TO SAVEPOINT ${savepointName}`,
					);
					await client.query(`RELEASE SAVEPOINT ${savepointName}`);
				});
				throw err;
			}
		},
	};
}

export function compileQuery(
	parts: TemplateStringsArray,
	values: unknown[],
): CompiledQuery {
	let text = "";
	const params: unknown[] = [];

	for (let i = 0; i < parts.length; i++) {
		text += parts[i];
		if (i < values.length) {
			params.push(values[i]);
			text += `$${params.length}`;
		}
	}

	return { text, params };
}

function createExecutorFromDriver(
	driver: DatabaseClient,
	inTransaction: boolean,
	hooks: QueryHooks | undefined,
): Executor {
	return {
		inTransaction,
		...wrapQueryMethods(
			{
				async query<T = Record<string, unknown>>(
					text: string,
					params: unknown[] = [],
				): Promise<T[]> {
					const result = await driver.query<T>(text, params);
					return result.rows;
				},
				async queryOne<T = Record<string, unknown>>(
					text: string,
					params: unknown[] = [],
				): Promise<T | null> {
					const result = await driver.query<T>(text, params);
					return result.rows[0] ?? null;
				},
				async execute<T = Record<string, unknown>>(
					text: string,
					params: unknown[] = [],
				): Promise<ExecuteResult<T>> {
					const result = await driver.query<T>(text, params);
					return { rows: result.rows, rowCount: result.rowCount };
				},
			},
			hooks,
			inTransaction,
		),
		async transaction<T>(
			fn: (tx: Executor) => Promise<T>,
			options?: TransactionOptions,
		): Promise<T> {
			return driver.transaction(
				(txDriver) =>
					fn(createExecutorFromDriver(txDriver, true, hooks)),
				options,
			);
		},
	};
}

function isSqliteDatabaseLike(
	value: SqliteDatabaseLike | DatabaseClient,
): value is SqliteDatabaseLike {
	return "prepare" in value && typeof value.prepare === "function";
}

export function createSqliteExecutor(
	db: SqliteDatabaseLike | DatabaseClient,
	options?: ExecutorOptions,
): Executor {
	const driver = isSqliteDatabaseLike(db) ? sqliteClient(db) : db;
	return createExecutorFromDriver(driver, false, options);
}
