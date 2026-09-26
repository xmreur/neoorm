import { spawn } from "node:child_process";
import {
	access,
	mkdtemp,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireMigrateDevLock,
	MIGRATE_DEV_LOCK_FILENAME,
	withMigrateDevLock,
} from "../src/migrate/dev-lock.js";

type FsOpen = typeof import("node:fs/promises").open;
type FsStat = typeof import("node:fs/promises").stat;

const { fsOverrides } = vi.hoisted(() => ({
	fsOverrides: {
		open: [] as Array<(...args: Parameters<FsOpen>) => ReturnType<FsOpen>>,
		stat: [] as Array<(...args: Parameters<FsStat>) => ReturnType<FsStat>>,
	},
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: (...args: Parameters<FsOpen>): ReturnType<FsOpen> => {
			const override = fsOverrides.open.shift();
			if (override) return override(...args);
			return actual.open(...args);
		},
		stat: (...args: Parameters<FsStat>): ReturnType<FsStat> => {
			const override = fsOverrides.stat.shift();
			if (override) return override(...args);
			return actual.stat(...args);
		},
	};
});

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function deadChildPid(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
			stdio: "ignore",
		});
		if (child.pid === undefined) {
			reject(new Error("expected child pid"));
			return;
		}
		const pid = child.pid;
		child.on("error", reject);
		child.on("exit", () => resolve(pid));
	});
}

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
			onWait: () => {},
		});
		order.push("first-acquired");

		const second = acquireMigrateDevLock(tmpDir, {
			timeoutMs: 5000,
			pollIntervalMs: 20,
			onWait: () => {},
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
		const waits: string[] = [];
		const release = await acquireMigrateDevLock(tmpDir);

		await expect(
			acquireMigrateDevLock(tmpDir, {
				timeoutMs: 200,
				pollIntervalMs: 20,
				onWait: (message) => waits.push(message),
			}),
		).rejects.toThrow(/Another `neoorm migrate dev` is running/);

		expect(waits).toHaveLength(1);
		expect(waits[0]).toContain(MIGRATE_DEV_LOCK_FILENAME);
		await release();
	});

	it("times out while a live holder still owns the lock", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-dev-lock-"));
		const lockPath = join(tmpDir, MIGRATE_DEV_LOCK_FILENAME);
		await writeFile(lockPath, `${process.pid}:live:${Date.now()}`, "utf-8");

		await expect(
			acquireMigrateDevLock(tmpDir, {
				timeoutMs: 150,
				pollIntervalMs: 20,
				staleMs: 60_000,
				onWait: () => {},
			}),
		).rejects.toThrow(/Another `neoorm migrate dev` is running/);
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

	it("takes over a lock whose holder pid is dead", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-dev-lock-"));
		const lockPath = join(tmpDir, MIGRATE_DEV_LOCK_FILENAME);
		const pid = await deadChildPid();
		await writeFile(lockPath, `${pid}:dead:${Date.now()}`, "utf-8");

		const started = Date.now();
		const release = await acquireMigrateDevLock(tmpDir, {
			timeoutMs: 2000,
			staleMs: 60_000,
			pollIntervalMs: 20,
			onWait: () => {
				throw new Error("should not wait on a dead holder");
			},
		});
		expect(Date.now() - started).toBeLessThan(500);
		await release();
		expect(await fileExists(lockPath)).toBe(false);
	});

	it("does not release a lock whose content merely contains our token", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-dev-lock-"));
		const lockPath = join(tmpDir, MIGRATE_DEV_LOCK_FILENAME);
		const release = await acquireMigrateDevLock(tmpDir, {
			onWait: () => {},
		});
		const content = await readFile(lockPath, "utf-8");
		await writeFile(lockPath, `tampered:${content}`, "utf-8");

		await release();

		expect(await fileExists(lockPath)).toBe(true);
	});

	it("removes the partial lock and closes the handle when the write fails", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-dev-lock-"));
		const lockPath = join(tmpDir, MIGRATE_DEV_LOCK_FILENAME);
		const { open: realOpen } =
			await vi.importActual<typeof import("node:fs/promises")>(
				"node:fs/promises",
			);
		let closeCalls = 0;
		fsOverrides.open.push(async (...args) => {
			const fh = await realOpen(...args);
			const originalClose = fh.close.bind(fh);
			vi.spyOn(fh, "close").mockImplementation(async () => {
				closeCalls++;
				return originalClose();
			});
			vi.spyOn(fh, "writeFile").mockRejectedValueOnce(
				Object.assign(new Error("No space left on device"), {
					code: "ENOSPC",
				}),
			);
			return fh;
		});

		await expect(
			acquireMigrateDevLock(tmpDir, { onWait: () => {} }),
		).rejects.toThrow("No space left on device");
		expect(closeCalls).toBe(1);
		expect(await fileExists(lockPath)).toBe(false);
	});

	it("rethows stat errors instead of waiting out the timeout", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-dev-lock-"));
		const lockPath = join(tmpDir, MIGRATE_DEV_LOCK_FILENAME);
		await writeFile(lockPath, `${process.pid}:live:${Date.now()}`, "utf-8");
		fsOverrides.stat.push(async () => {
			throw Object.assign(new Error("EACCES: permission denied"), {
				code: "EACCES",
			});
		});

		await expect(
			acquireMigrateDevLock(tmpDir, {
				timeoutMs: 2000,
				pollIntervalMs: 20,
				onWait: () => {},
			}),
		).rejects.toThrow("EACCES");
	});
});

describe("withMigrateDevLock", () => {
	let tmpDir: string;

	afterEach(async () => {
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	});

	it("releases the lock after the callback returns", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-dev-lock-"));
		const lockPath = join(tmpDir, MIGRATE_DEV_LOCK_FILENAME);
		let held = false;

		await withMigrateDevLock(tmpDir, async () => {
			held = await fileExists(lockPath);
		});

		expect(held).toBe(true);
		expect(await fileExists(lockPath)).toBe(false);
	});

	it("releases the lock when the callback throws", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-dev-lock-"));
		const lockPath = join(tmpDir, MIGRATE_DEV_LOCK_FILENAME);

		await expect(
			withMigrateDevLock(tmpDir, async () => {
				throw new Error("blocked generate");
			}),
		).rejects.toThrow("blocked generate");

		expect(await fileExists(lockPath)).toBe(false);
	});
});
