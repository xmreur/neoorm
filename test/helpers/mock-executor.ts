import { vi } from "vitest";
import type { Executor } from "../../src/runtime/executor.js";

export type MockExecutor = Executor & {
	queries: { sql: string; params: unknown[] }[];
};

export function createMockExecutor(handlers?: {
	query?: (sql: string, params?: unknown[]) => Record<string, unknown>[];
	queryOne?: (
		sql: string,
		params?: unknown[],
	) => Record<string, unknown> | null;
	execute?: (
		sql: string,
		params?: unknown[],
	) => { rows: Record<string, unknown>[]; rowCount: number };
}): MockExecutor {
	const queries: { sql: string; params: unknown[] }[] = [];

	const runTrackedQuery = (sql: string, params?: unknown[]) => {
		queries.push({ sql, params: params ?? [] });
		return handlers?.query?.(sql, params) ?? [];
	};

	return {
		queries,
		inTransaction: false,
		query: vi.fn(
			async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
				runTrackedQuery(sql, params) as T[],
		) as Executor["query"],
		queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
			queries.push({ sql, params: params ?? [] });
			if (handlers?.queryOne) {
				return handlers.queryOne(sql, params);
			}
			const rows = runTrackedQuery(sql, params);
			return rows[0] ?? null;
		}) as Executor["queryOne"],
		execute: vi.fn(async (sql: string, params?: unknown[]) => {
			queries.push({ sql, params: params ?? [] });
			if (handlers?.execute) {
				return handlers.execute(sql, params);
			}
			const rows = handlers?.query?.(sql, params) ?? [];
			return { rows, rowCount: rows.length };
		}) as Executor["execute"],
		transaction: vi.fn(async (fn) =>
			fn(createMockExecutor(handlers)),
		) as Executor["transaction"],
	};
}
