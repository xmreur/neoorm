import { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { emptyManifest } from "../codegen/diff-manifest.js";
import { createNeoOrmClient, createNeoOrmClientFromPool } from "./client.js";
import {
	checkDriverHealth,
	isTransientConnectionError,
	resolveRetryOptions,
	startConnectionKeepalive,
	withRetry,
} from "./connection-health.js";
import type { DatabaseClient } from "./driver.js";
import { NeoOrmDriverError } from "./errors.js";
import { runQuery } from "./query/execute.js";

function fakePool(
	impl: (
		text: string,
	) => Promise<never> | Promise<{ rows: never[]; rowCount: number }>,
): Pool {
	return {
		end: vi.fn(async () => undefined),
		query: vi.fn(impl),
		connect: vi.fn(),
	} as unknown as Pool;
}

function fakeDriver(
	query: (text: string) => Promise<{ rows: never[]; rowCount: number }>,
): DatabaseClient {
	return {
		query: vi.fn(query),
		transaction: vi.fn(),
		close: vi.fn(async () => undefined),
	};
}

describe("isTransientConnectionError", () => {
	it("matches PG transient codes and Node reset", () => {
		expect(isTransientConnectionError({ code: "57P01" })).toBe(true);
		expect(isTransientConnectionError({ code: "08006" })).toBe(true);
		expect(isTransientConnectionError({ code: "ECONNRESET" })).toBe(true);
		expect(
			isTransientConnectionError(
				new NeoOrmDriverError(
					"SELECT 1",
					Object.assign(new Error("read ECONNRESET"), {
						code: "ECONNRESET",
					}),
				),
			),
		).toBe(true);
	});

	it("rejects constraint violations and plain TypeErrors", () => {
		expect(isTransientConnectionError({ code: "23505" })).toBe(false);
		expect(isTransientConnectionError(new TypeError("boom"))).toBe(false);
	});

	it("matches MySQL lost-connection codes", () => {
		expect(
			isTransientConnectionError({ code: "PROTOCOL_CONNECTION_LOST" }),
		).toBe(true);
		expect(isTransientConnectionError({ errno: 2013 })).toBe(true);
		expect(isTransientConnectionError({ errno: 1062 })).toBe(false);
	});
});

describe("withRetry", () => {
	it("resolves after two transient failures", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("x"), { code: "57P01" }),
			)
			.mockRejectedValueOnce(
				Object.assign(new Error("x"), { code: "57P01" }),
			)
			.mockResolvedValueOnce("ok");
		const result = await withRetry(
			fn,
			resolveRetryOptions({ baseMs: 1, maxMs: 1 }),
			true,
		);
		expect(result).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("throws after maxAttempts", async () => {
		const fn = vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error("x"), { code: "57P01" }),
			);
		await expect(
			withRetry(
				fn,
				resolveRetryOptions({ maxAttempts: 2, baseMs: 1, maxMs: 1 }),
				true,
			),
		).rejects.toThrow("x");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("does not retry non-transient failures", async () => {
		const fn = vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error("unique"), { code: "23505" }),
			);
		await expect(
			withRetry(fn, resolveRetryOptions({ baseMs: 1, maxMs: 1 }), true),
		).rejects.toThrow("unique");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries writes only with retryWrites", async () => {
		const transient = () =>
			Object.assign(new Error("gone"), { code: "57P01" });
		const once = vi.fn().mockRejectedValueOnce(transient());
		await expect(
			withRetry(
				once,
				resolveRetryOptions({ baseMs: 1, maxMs: 1 }),
				false,
			),
		).rejects.toThrow("gone");
		expect(once).toHaveBeenCalledTimes(1);

		const twice = vi
			.fn()
			.mockRejectedValueOnce(transient())
			.mockResolvedValueOnce("ok");
		const result = await withRetry(
			twice,
			resolveRetryOptions({ baseMs: 1, maxMs: 1, retryWrites: true }),
			false,
		);
		expect(result).toBe("ok");
		expect(twice).toHaveBeenCalledTimes(2);
	});
});

describe("$healthCheck", () => {
	it("returns ok for a resolving pool", async () => {
		const pool = fakePool(async () => ({ rows: [], rowCount: 0 }));
		const client = createNeoOrmClientFromPool(emptyManifest(), pool);
		const result = await client.$healthCheck();
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.latencyMs).toEqual(expect.any(Number));
	});

	it("returns ok:false without throwing for a rejecting pool", async () => {
		const pool = fakePool(async () => {
			throw new Error("down");
		});
		const client = createNeoOrmClientFromPool(emptyManifest(), pool);
		const result = await client.$healthCheck();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toEqual(expect.any(String));
	});

	it("never throws from checkDriverHealth", async () => {
		const driver = fakeDriver(async () => {
			throw new Error("down");
		});
		const result = await checkDriverHealth(driver);
		expect(result).toMatchObject({ ok: false });
	});
});

describe("keepalive", () => {
	it("pings on interval and stops", () => {
		vi.useFakeTimers();
		try {
			const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
			const driver = fakeDriver(query);
			const stop = startConnectionKeepalive(driver, 1000);
			vi.advanceTimersByTime(3000);
			expect(query).toHaveBeenCalledTimes(3);
			stop();
			vi.advanceTimersByTime(3000);
			expect(query).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects intervals below 1000ms", () => {
		const driver = fakeDriver(async () => ({ rows: [], rowCount: 0 }));
		expect(() => startConnectionKeepalive(driver, 100)).toThrow(
			expect.objectContaining({ code: "invalid_config" }),
		);
	});
});

describe("runQuery retry integration", () => {
	it("resolves on second call with retry", async () => {
		const query = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("gone"), { code: "57P01" }),
			)
			.mockResolvedValueOnce([]);
		const executor = {
			query,
			queryOne: vi.fn(),
			execute: vi.fn(),
			transaction: vi.fn(),
		};
		const rows = await runQuery(
			executor,
			{
				manifest: emptyManifest(),
				retry: resolveRetryOptions({ baseMs: 1, maxMs: 1 }),
			},
			{ operation: "select" },
			"SELECT 1",
		);
		expect(rows).toEqual([]);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("never retries inside transactions", async () => {
		const query = vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error("gone"), { code: "57P01" }),
			);
		const executor = {
			inTransaction: true,
			query,
			queryOne: vi.fn(),
			execute: vi.fn(),
			transaction: vi.fn(),
		};
		await expect(
			runQuery(
				executor,
				{
					manifest: emptyManifest(),
					retry: resolveRetryOptions({ baseMs: 1, maxMs: 1 }),
				},
				{ operation: "select" },
				"SELECT 1",
			),
		).rejects.toThrow("gone");
		expect(query).toHaveBeenCalledTimes(1);
	});
});

describe("sqlite keepalive rejection", () => {
	it("throws for sqlite in-memory with keepalive", () => {
		const db = new DatabaseSync(":memory:");
		try {
			expect(() =>
				createNeoOrmClient(
					{
						version: 1,
						provider: "sqlite",
						url: ":memory:",
						tables: {},
						manyToMany: [],
					} as never,
					{
						db,
						keepalive: { intervalMs: 1000 },
					} as never,
				),
			).toThrow(/keepalive is only supported/);
		} finally {
			db.close();
		}
	});
});
