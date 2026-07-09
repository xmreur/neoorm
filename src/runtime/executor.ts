import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import type { CompiledQuery } from "../dialect/types.js";
import type { TransactionOptions } from "./types.js";

export type ExecuteResult<T = Record<string, unknown>> = {
	rows: T[];
	rowCount: number;
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
};

const isolationLevelSql: Record<
	NonNullable<TransactionOptions["isolationLevel"]>,
	string
> = {
	ReadUncommitted: "READ UNCOMMITTED",
	ReadCommitted: "READ COMMITTED",
	RepeatableRead: "REPEATABLE READ",
	Serializable: "SERIALIZABLE",
};

export function buildBeginSql(options?: TransactionOptions): string {
	const parts = ["BEGIN"];

	if (options?.readOnly) {
		parts.push("READ ONLY");
	}

	if (options?.isolationLevel) {
		parts.push(
			`ISOLATION LEVEL ${isolationLevelSql[options.isolationLevel]}`,
		);
	}

	return parts.join(" ");
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

const statementNameCache = new Map<string, string>();

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

export function buildSavepointName(id: number): string {
	return `neoorm_sp_${id}`;
}

function assertNoSavepointOptions(options?: TransactionOptions): void {
	if (
		options?.readOnly !== undefined ||
		options?.isolationLevel !== undefined
	) {
		throw new Error(
			"Transaction options (readOnly, isolationLevel) cannot be used with nested transactions",
		);
	}
}

function createQueryMethods(
	client: Queryable,
	usePrepared: boolean,
): Pick<Executor, "query" | "queryOne" | "execute"> {
	return {
		async query<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<T[]> {
			const result = await runQuery(client, text, params, usePrepared);
			return rowsFromResult(result) as T[];
		},

		async queryOne<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<T | null> {
			const result = await runQuery(client, text, params, usePrepared);
			const rows = rowsFromResult(result);
			return (rows[0] as T | undefined) ?? null;
		},

		async execute<T = Record<string, unknown>>(
			text: string,
			params: unknown[] = [],
		): Promise<ExecuteResult<T>> {
			const result = await runQuery(client, text, params, usePrepared);
			return executeFromResult<T>(result);
		},
	};
}

export function createExecutor(
	pool: Pool,
	options?: ExecutorOptions,
): Executor {
	const usePrepared = options?.preparedStatements ?? false;
	const queryMethods = createQueryMethods(pool, usePrepared);

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
				const tx = createClientExecutor(state, usePrepared);
				const result = await fn(tx);
				await client.query("COMMIT");
				return result;
			} catch (err) {
				await client.query("ROLLBACK");
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
): Executor {
	const { client } = state;
	const queryMethods = createQueryMethods(client, usePrepared);

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
				const result = await fn(createClientExecutor(state, usePrepared));
				await client.query(`RELEASE SAVEPOINT ${savepointName}`);
				return result;
			} catch (err) {
				await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
				await client.query(`RELEASE SAVEPOINT ${savepointName}`);
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
