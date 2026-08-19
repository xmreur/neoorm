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

export function assertNoSavepointOptions(options?: TransactionOptions): void {
	if (
		options?.readOnly !== undefined ||
		options?.isolationLevel !== undefined
	) {
		throw new Error(
			"Transaction options (readOnly, isolationLevel) cannot be used with nested transactions",
		);
	}
}