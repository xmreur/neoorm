import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireMigrateDevLock,
	MIGRATE_DEV_LOCK_FILENAME,
} from "../src/migrate/dev-lock.js";

describe("acquireMigrateDevLock", () => {
	let tmpDir: string;

	afterEach(async () => {
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	});

	it("serializes concurrent acquirers", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-dev-lock-"));
		const order: string[] = [];

		const release1 = await acquireMigrateDevLock(tmpDir, {
			timeoutMs: 5000,
		});
		order.push("first-acquired");

		const second = acquireMigrateDevLock(tmpDir, {
			timeoutMs: 5000,
			pollIntervalMs: 20,
		}).then((release) => {
			order.push("second-acquired");
			return release;
		});
		// Real delay: proves the second acquirer blocks on wall-clock polling,
		// which fake timers cannot exercise against fs-backed lock retries.
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		expect(order).toEqual(["first-acquired"]);

		await release1();
		order.push("first-released");
		const release2 = await second;
		expect(order).toEqual([
			"first-acquired",
			"first-released",
			"second-acquired",
		]);
		await release2();
	});

	it("times out with the holder description", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-dev-lock-"));
		const release = await acquireMigrateDevLock(tmpDir);

		await expect(
			acquireMigrateDevLock(tmpDir, {
				timeoutMs: 200,
				pollIntervalMs: 20,
			}),
		).rejects.toThrow(/Another `neoorm migrate dev` is running/);

		await release();
	});

	it("takes over a stale lock", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-dev-lock-"));
		const lockPath = join(tmpDir, MIGRATE_DEV_LOCK_FILENAME);
		await writeFile(lockPath, "0:stale:0", "utf-8");
		const old = new Date(Date.now() - 60_000);
		await utimes(lockPath, old, old);

		const release = await acquireMigrateDevLock(tmpDir, { staleMs: 1000 });
		await release();
	});
});
