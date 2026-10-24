import { queryError } from "./error-builders.js";
import { QueryErrorCode } from "./error-codes.js";
import type { TransactionOptions } from "./types.js";

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

export function buildMysqlBeginStatements(
	options?: TransactionOptions,
): string[] {
	const stmts: string[] = [];
	if (options?.isolationLevel) {
		stmts.push(
			`SET TRANSACTION ISOLATION LEVEL ${isolationLevelSql[options.isolationLevel]}`,
		);
	}
	stmts.push(
		options?.readOnly ? "START TRANSACTION READ ONLY" : "START TRANSACTION",
	);
	return stmts;
}

export function buildSavepointName(id: number): string {
	return `neoorm_sp_${id}`;
}

/** SQLite BEGIN form for an outer transaction. Isolation names map to lock timing only. */
export function buildSqliteBeginSql(options?: TransactionOptions): string {
	const level = options?.isolationLevel;
	if (level === undefined) {
		return "BEGIN";
	}
	switch (level) {
		case "RepeatableRead":
		case "Serializable":
			return "BEGIN IMMEDIATE";
		case "ReadUncommitted":
		case "ReadCommitted":
			return "BEGIN";
		default: {
			const _exhaustive: never = level;
			return _exhaustive;
		}
	}
}

export function assertNoSavepointOptions(options?: TransactionOptions): void {
	if (
		options?.readOnly !== undefined ||
		options?.isolationLevel !== undefined
	) {
		throw queryError(
			QueryErrorCode.invalid_args,
			"Transaction options (readOnly, isolationLevel) cannot be used with nested transactions",
			{ operation: "raw", phase: "runtime" },
		);
	}
}

/** Run ROLLBACK cleanup without masking the error that triggered it. */
export async function rollbackIgnoringFailure(
	rollback: () => Promise<unknown>,
): Promise<void> {
	try {
		await rollback();
	} catch {
		// Connection may already be dead; never mask the original error.
	}
}

/**
 * Thrown when a savepoint could not be popped. The outer transaction must
 * roll back; committing would leave that savepoint on the session stack.
 */
export class SavepointStackError extends Error {
	constructor() {
		super(
			"Transaction aborted because a savepoint could not be released after rollback",
		);
		this.name = "SavepointStackError";
	}
}

export function assertSavepointStackOpen(poisoned: boolean): void {
	if (poisoned) throw new SavepointStackError();
}

/**
 * Run `body` inside a savepoint.
 * `ROLLBACK TO` and `RELEASE` are separate steps: a failed `RELEASE` after a
 * successful `ROLLBACK TO` must not replace the original error, and must not
 * be ignored, because the savepoint is still allocated. `markPoisoned` tells
 * the outer transaction to roll back instead of committing.
 */
export async function runInSavepoint<T>(
	exec: (sql: string) => unknown,
	name: string,
	body: () => Promise<T>,
	markPoisoned: () => void,
): Promise<T> {
	await exec(`SAVEPOINT ${name}`);
	try {
		const result = await body();
		await exec(`RELEASE SAVEPOINT ${name}`);
		return result;
	} catch (err) {
		if ((await rollbackAndReleaseSavepoint(exec, name)) === "poison") {
			markPoisoned();
		}
		throw err;
	}
}

async function rollbackAndReleaseSavepoint(
	exec: (sql: string) => unknown,
	name: string,
): Promise<"clean" | "poison"> {
	try {
		await exec(`ROLLBACK TO SAVEPOINT ${name}`);
	} catch {
		return "poison";
	}
	try {
		await exec(`RELEASE SAVEPOINT ${name}`);
		return "clean";
	} catch {
		return "poison";
	}
}
