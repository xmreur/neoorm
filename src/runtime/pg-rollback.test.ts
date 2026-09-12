import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { pgClient } from "./driver.js";
import { createExecutor } from "./executor.js";

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
});
