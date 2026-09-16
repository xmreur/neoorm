import type { Manifest, ManifestTable } from "../dialect/types.js";
import { QueryErrorCode, type QueryErrorCodeValue } from "./error-codes.js";
import type { QueryErrorContext } from "./errors.js";
import { truncateSql } from "./pg-error.js";

export type MysqlErrorLike = {
	errno?: number;
	code?: string;
	sqlMessage?: string;
	message?: string;
	sqlState?: string;
};

const MYSQL_ERRNO = {
	dupEntry: 1062,
	badNull: 1048,
	noReferencedRow: 1452,
	rowIsReferenced: 1451,
	checkConstraint: 3819,
	mariadbConstraintFailed: 4025,
	noSuchTable: 1146,
	badField: 1054,
} as const;

export function isMysqlError(err: unknown): err is MysqlErrorLike {
	if (typeof err !== "object" || err === null) {
		return false;
	}
	const errno = (err as MysqlErrorLike).errno;
	const code = (err as MysqlErrorLike).code;
	return (
		typeof errno === "number" ||
		(typeof code === "string" && code.startsWith("ER_"))
	);
}

function findTableBySqlName(
	manifest: Manifest,
	sqlName: string | undefined,
): ManifestTable | undefined {
	if (!sqlName) return undefined;
	return Object.values(manifest.tables).find(
		(table) => table.sqlName === sqlName,
	);
}

function headlineForMysql(errno: number | undefined, message: string): string {
	switch (errno) {
		case MYSQL_ERRNO.dupEntry:
			return "duplicate value violates unique constraint";
		case MYSQL_ERRNO.badNull:
			return "null value violates not-null constraint";
		case MYSQL_ERRNO.noReferencedRow:
		case MYSQL_ERRNO.rowIsReferenced:
			return "foreign key violation";
		case MYSQL_ERRNO.checkConstraint:
		case MYSQL_ERRNO.mariadbConstraintFailed:
			return "check constraint violated";
		case MYSQL_ERRNO.noSuchTable:
			return "table does not exist";
		case MYSQL_ERRNO.badField:
			return "column does not exist";
		default:
			return message;
	}
}

function errorCodeForMysql(errno: number | undefined): QueryErrorCodeValue {
	switch (errno) {
		case MYSQL_ERRNO.dupEntry:
			return QueryErrorCode.unique_violation;
		case MYSQL_ERRNO.badNull:
			return QueryErrorCode.not_null_violation;
		case MYSQL_ERRNO.noReferencedRow:
		case MYSQL_ERRNO.rowIsReferenced:
			return QueryErrorCode.foreign_key_violation;
		case MYSQL_ERRNO.checkConstraint:
		case MYSQL_ERRNO.mariadbConstraintFailed:
			return QueryErrorCode.check_violation;
		case MYSQL_ERRNO.noSuchTable:
			return QueryErrorCode.relation_not_found;
		case MYSQL_ERRNO.badField:
			return QueryErrorCode.column_not_found;
		default:
			return QueryErrorCode.driver_error;
	}
}

export function isSchemaDriftMysqlErrno(errno: number | undefined): boolean {
	return (
		errno === MYSQL_ERRNO.noSuchTable ||
		errno === MYSQL_ERRNO.badField ||
		errno === MYSQL_ERRNO.noReferencedRow
	);
}

export function enrichMysqlError(
	err: MysqlErrorLike,
	manifest: Manifest,
	base: Pick<QueryErrorContext, "operation" | "sql"> & {
		tableAccessor?: string;
	},
): QueryErrorContext {
	const message = err.sqlMessage ?? err.message ?? "MySQL error";
	const table = base.tableAccessor
		? manifest.tables[base.tableAccessor]
		: findTableBySqlName(manifest, undefined);

	const code = errorCodeForMysql(err.errno);
	const context: QueryErrorContext = {
		operation: base.operation,
		phase: "runtime",
		sql: truncateSql(base.sql),
		code,
		detail: headlineForMysql(err.errno, message),
	};

	const tableAccessor = base.tableAccessor ?? table?.accessor;
	if (tableAccessor !== undefined) {
		context.tableAccessor = tableAccessor;
	}
	if (table?.sqlName !== undefined) {
		context.tableSqlName = table.sqlName;
	}
	if (err.code !== undefined) {
		context.pgCode = err.code;
	}

	switch (code) {
		case QueryErrorCode.unique_violation:
			context.suggestions = [
				"A record with the same unique value already exists",
				"Use upsert() or update an existing row instead of insert",
			];
			break;
		case QueryErrorCode.foreign_key_violation:
			context.suggestions = [
				"The referenced parent row does not exist",
				"Create the parent record first, or verify relation connect/write syntax",
			];
			break;
		case QueryErrorCode.relation_not_found:
		case QueryErrorCode.column_not_found:
			context.suggestions = [
				"Run `neoorm migrate deploy` and regenerate the client (`neoorm generate`)",
			];
			break;
		default:
			break;
	}

	return context;
}
