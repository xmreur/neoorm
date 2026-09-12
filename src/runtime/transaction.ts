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
