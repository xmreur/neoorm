import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { pgClient } from "./driver.js";
import { createExecutor } from "./executor.js";
import { SavepointStackError } from "./transaction.js";

function poolWithFailingRollback() {
	const client = {
		query: vi.fn(async (sql: string) => {
			if (sql === "ROLLBACK") {
				throw new Error("connection terminated");
			}
			return { rows: [], rowCount: 0 };
		}),
		release: vi.fn(),
	};
	const pool = {
		connect: async () => client,
	} as unknown as Pool;
	return { pool, client };
}

describe("Postgres ROLLBACK on transaction failure", () => {
	it("createExecutor rethrows the original error if ROLLBACK fails", async () => {
		const { pool, client } = poolWithFailingRollback();
		const executor = createExecutor(pool);
		await expect(
			executor.transaction(async () => {
				throw new Error("original boom");
			}),
		).rejects.toThrow("original boom");
		expect(client.query).toHaveBeenCalledWith("ROLLBACK");
		expect(client.release).toHaveBeenCalledOnce();
	});

	it("pgClient.transaction rethrows the original error if ROLLBACK fails", async () => {
		const { pool, client } = poolWithFailingRollback();
		const driver = pgClient(pool);
		await expect(
			driver.transaction(async () => {
				throw new Error("original boom");
			}),
		).rejects.toThrow("original boom");
		expect(client.query).toHaveBeenCalledWith("ROLLBACK");
		expect(client.release).toHaveBeenCalledOnce();
	});

	it("preserves the nested error when RELEASE fails after ROLLBACK TO", async () => {
		const queries: string[] = [];
		const client = {
			query: vi.fn(async (sql: string) => {
				queries.push(sql);
				if (
					sql.startsWith("RELEASE SAVEPOINT") &&
					queries.some((entry) => entry.startsWith("ROLLBACK TO"))
				) {
					throw new Error("release failed");
				}
				return { rows: [], rowCount: 0 };
			}),
			release: vi.fn(),
		};
		const pool = {
			connect: async () => client,
		} as unknown as Pool;
		const driver = pgClient(pool);

		let nestedMessage = "";
		await expect(
			driver.transaction(async (tx) => {
				try {
					await tx.transaction(async () => {
						throw new Error("inner boom");
					});
				} catch (err) {
					nestedMessage = err instanceof Error ? err.message : "";
					await tx.query("SELECT 1");
				}
			}),
		).rejects.toBeInstanceOf(SavepointStackError);

		expect(nestedMessage).toBe("inner boom");
		expect(queries).toEqual([
			"BEGIN",
			"SAVEPOINT neoorm_sp_1",
			"ROLLBACK TO SAVEPOINT neoorm_sp_1",
			"RELEASE SAVEPOINT neoorm_sp_1",
			"ROLLBACK",
		]);
		expect(queries).not.toContain("SELECT 1");
		expect(queries).not.toContain("COMMIT");
		expect(client.release).toHaveBeenCalledOnce();
	});
});
