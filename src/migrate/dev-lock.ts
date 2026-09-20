import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export type MigrateDevLockOptions = {
	timeoutMs?: number;
	pollIntervalMs?: number;
	staleMs?: number;
	onWait?: (message: string) => void;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_MS = 60_000;

export const MIGRATE_DEV_LOCK_FILENAME = ".neoorm-migrate-dev.lock";

type FsError = {
	code?: string;
};

function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const entry = error as FsError;
		return typeof entry.code === "string" ? entry.code : undefined;
	}
	return undefined;
}
function isNotFoundError(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}
async function delay(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function readHolderDesc(lockPath: string): Promise<string> {
	try {
		return (await readFile(lockPath, "utf-8")).trim() || "unknown";
	} catch {
		return "unknown";
	}
}

function parseLockPid(holderDesc: string): number | undefined {
	const pidPart = holderDesc.split(":")[0];
	if (pidPart === undefined) return undefined;
	const pid = Number.parseInt(pidPart, 10);
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	return pid;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

async function tryUnlinkLock(lockPath: string): Promise<void> {
	try {
		await unlink(lockPath);
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
	}
}

/**
 * Acquire an exclusive file lock for `neoorm migrate dev` in `outDir`.
 *
 * Mutual exclusion comes from atomic exclusive-create (`O_EXCL` via `"wx"`).
 * The lock file is never written with a truncating write, so concurrent
 * acquirers cannot interleave content — exactly one creator wins.
 */
export async function acquireMigrateDevLock(
	outDir: string,
	options: MigrateDevLockOptions = {},
): Promise<() => Promise<void>> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const onWait =
		options.onWait ??
		((message: string) => {
			console.error(message);
		});
	const lockPath = join(outDir, MIGRATE_DEV_LOCK_FILENAME);
	const token = randomUUID();
	const content = `${process.pid}:${token}:${Date.now()}`;
	const start = Date.now();
	let loggedWait = false;

	await mkdir(outDir, { recursive: true });

	while (true) {
		try {
			const fh = await open(lockPath, "wx");
			await fh.writeFile(content, "utf-8");
			await fh.close();
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				try {
					const current = await readFile(lockPath, "utf-8");
					if (!current.includes(token)) return;
					await unlink(lockPath);
				} catch (error) {
					if (!isNotFoundError(error)) throw error;
				}
			};
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}

		const holderDesc = await readHolderDesc(lockPath);
		const holderPid = parseLockPid(holderDesc);
		if (holderPid !== undefined && !isPidAlive(holderPid)) {
			await tryUnlinkLock(lockPath);
			continue;
		}

		try {
			const fileStat = await stat(lockPath);
			const ageMs = Date.now() - fileStat.mtimeMs;
			if (ageMs > staleMs) {
				await tryUnlinkLock(lockPath);
				continue;
			}
		} catch (error) {
			if (isNotFoundError(error)) continue;
		}

		if (!loggedWait) {
			loggedWait = true;
			onWait(
				`Waiting for another migrate dev (lock: ${lockPath}, holder: ${holderDesc})`,
			);
		}

		if (Date.now() - start > timeoutMs) {
			throw new Error(
				`Another \`neoorm migrate dev\` is running in ${outDir} (lock: ${lockPath}, holder: ${holderDesc}, waited ${timeoutMs}ms). Wait for it to finish and re-run.`,
			);
		}
		await delay(pollIntervalMs);
	}
}

const LOCK_SIGNALS = ["SIGINT", "SIGTERM"] as const;

function signalExitCode(signal: NodeJS.Signals): number {
	return signal === "SIGTERM" ? 143 : 130;
}

/**
 * Hold the migrate-dev lock for `fn`, releasing it on return, throw, or
 * SIGINT/SIGTERM.
 */
export async function withMigrateDevLock<T>(
	outDir: string,
	fn: () => Promise<T>,
	options: MigrateDevLockOptions = {},
): Promise<T> {
	const release = await acquireMigrateDevLock(outDir, options);
	const onSignal = (signal: NodeJS.Signals) => {
		void release().finally(() => {
			process.exit(signalExitCode(signal));
		});
	};
	for (const signal of LOCK_SIGNALS) {
		process.once(signal, onSignal);
	}
	try {
		return await fn();
	} finally {
		for (const signal of LOCK_SIGNALS) {
			process.off(signal, onSignal);
		}
		await release();
	}
}
