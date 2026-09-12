import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { emptyManifest } from "../codegen/diff-manifest.js";
import { createNeoOrmClientFromPool } from "./client.js";

function fakePool(): Pool & { end: ReturnType<typeof vi.fn> } {
	return {
		end: vi.fn(async () => undefined),
		query: vi.fn(),
		connect: vi.fn(),
	} as unknown as Pool & { end: ReturnType<typeof vi.fn> };
}

describe("createNeoOrmClientFromPool", () => {
	it("does not end the caller's pool on $disconnect", async () => {
		const pool = fakePool();
		const client = createNeoOrmClientFromPool(emptyManifest(), pool);
		await client.$disconnect();
		expect(pool.end).not.toHaveBeenCalled();
	});
});
