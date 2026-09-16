import type { DatabaseClient } from "./driver.js";
import { schemaError } from "./error-builders.js";
import { SchemaErrorCode } from "./error-codes.js";
import { NeoOrmDriverError } from "./errors.js";

export type HealthCheckResult =
	| { ok: true; latencyMs: number }
	| { ok: false; latencyMs: number; error: string };

export type RetryOptions = {
	maxAttempts?: number;
	baseMs?: number;
	maxMs?: number;
	retryWrites?: boolean;
};

export type ResolvedRetryOptions = {
	maxAttempts: number;
	baseMs: number;
	maxMs: number;
	retryWrites: boolean;
};

export type ConnectionKeepaliveOptions = {
	intervalMs: number;
};

const PG_TRANSIENT_CODES: Record<string, true> = {
	"08000": true,
	"08003": true,
	"08006": true,
	"57P01": true,
	"57P02": true,
	"57P03": true,
};

const NODE_TRANSIENT_CODES: Record<string, true> = {
	ECONNRESET: true,
	ECONNREFUSED: true,
	ETIMEDOUT: true,
	EPIPE: true,
	ECONNABORTED: true,
};

const MYSQL_TRANSIENT_ERRNOS: Record<number, true> = {
	2003: true,
	2006: true,
	2011: true,
	2013: true,
};

function innermostCause(err: unknown): unknown {
	let current = err;
	const seen = new Set<unknown>();
	while (
		current instanceof Error &&
		current.cause !== undefined &&
		current.cause !== current &&
		!seen.has(current.cause)
	) {
		seen.add(current);
		current = current.cause;
	}
	if (current instanceof NeoOrmDriverError && current.cause !== undefined) {
		return innermostCause(current.cause);
	}
	return current;
}

type ErrorLike = {
	code?: unknown;
	errno?: unknown;
	message?: unknown;
};

function asErrorLike(err: unknown): ErrorLike | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	return err as ErrorLike;
}

export function isTransientConnectionError(err: unknown): boolean {
	const inner = innermostCause(err);
	const like = asErrorLike(inner);
	const code = typeof like?.code === "string" ? like.code : undefined;
	const errno = typeof like?.errno === "number" ? like.errno : undefined;
	const message =
		typeof like?.message === "string"
			? like.message
			: typeof inner === "string"
				? inner
				: "";

	if (code !== undefined) {
		if (PG_TRANSIENT_CODES[code] === true) return true;
		if (NODE_TRANSIENT_CODES[code] === true) return true;
		if (code === "PROTOCOL_CONNECTION_LOST") return true;
	}
	if (errno !== undefined && MYSQL_TRANSIENT_ERRNOS[errno] === true)
		return true;
	if (
		/connection terminated|server closed the connection unexpectedly/i.test(
			message,
		)
	) {
		return true;
	}
	if (/server has gone away|lost connection/i.test(message)) return true;
	return false;
}

export function resolveRetryOptions(input: RetryOptions): ResolvedRetryOptions;
export function resolveRetryOptions(
	input?: RetryOptions,
): ResolvedRetryOptions | undefined;
export function resolveRetryOptions(
	input?: RetryOptions,
): ResolvedRetryOptions | undefined {
	if (input === undefined) return undefined;
	return {
		maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? 3)),
		baseMs: input.baseMs ?? 100,
		maxMs: input.maxMs ?? 2000,
		retryWrites: input.retryWrites ?? false,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
	fn: () => Promise<T>,
	retry: ResolvedRetryOptions,
	isReadOnly: boolean,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			const canRetry =
				isTransientConnectionError(err) &&
				(isReadOnly || retry.retryWrites);
			if (!canRetry || attempt >= retry.maxAttempts) throw err;
			const delay = Math.min(
				retry.baseMs * 2 ** (attempt - 1),
				retry.maxMs,
			);
			await sleep(delay);
		}
	}
	throw lastError;
}

export function isReadOnlyQuery(sql: string): boolean {
	return /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql);
}

export async function checkDriverHealth(
	driver: DatabaseClient,
): Promise<HealthCheckResult> {
	const start = Date.now();
	try {
		await driver.query("SELECT 1");
		return { ok: true, latencyMs: Date.now() - start };
	} catch (err) {
		return {
			ok: false,
			latencyMs: Date.now() - start,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export function startConnectionKeepalive(
	driver: DatabaseClient,
	intervalMs: number,
): () => void {
	if (intervalMs < 1000) {
		throw schemaError(
			SchemaErrorCode.invalid_config,
			`keepalive intervalMs must be at least 1000, got ${intervalMs}`,
		);
	}
	const timer = setInterval(() => {
		void driver.query("SELECT 1").catch(() => {});
	}, intervalMs);
	const maybeUnref = timer as unknown as { unref?: () => void };
	if (typeof maybeUnref.unref === "function") {
		maybeUnref.unref();
	}
	return () => {
		clearInterval(timer);
	};
}
