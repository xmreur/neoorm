import { QueryErrorCode } from "../runtime/error-codes.js";
import { NeoOrmError } from "../runtime/errors.js";

export type StudioErrorBody = {
	error: {
		code: string;
		message: string;
		tableAccessor?: string;
		columnTsName?: string;
		columnSqlName?: string;
		constraint?: string;
		detail?: string;
	};
};

const CLIENT_ERROR_CODES = new Set<string>([
	QueryErrorCode.unique_violation,
	QueryErrorCode.not_null_violation,
	QueryErrorCode.foreign_key_violation,
	QueryErrorCode.check_violation,
	QueryErrorCode.invalid_input,
	QueryErrorCode.unknown_table,
	QueryErrorCode.unknown_column,
	QueryErrorCode.unknown_relation,
	QueryErrorCode.unique_where_invalid,
	QueryErrorCode.where_required,
	QueryErrorCode.invalid_args,
	QueryErrorCode.invalid_cursor,
	QueryErrorCode.invalid_nested_write,
	QueryErrorCode.missing_primary_key,
	QueryErrorCode.unsupported_operation,
	QueryErrorCode.relation_not_found,
	QueryErrorCode.column_not_found,
]);

const UNAVAILABLE_CODES = new Set<string>([
	QueryErrorCode.connection_error,
	QueryErrorCode.driver_error,
]);

/** Map a thrown error to an HTTP status + JSON body for Studio API responses. */
export function toStudioError(err: unknown): {
	status: number;
	body: StudioErrorBody;
} {
	if (err instanceof NeoOrmError) {
		const context =
			(err as { context?: Record<string, unknown> }).context ?? {};
		const tableAccessor =
			typeof context.tableAccessor === "string"
				? context.tableAccessor
				: undefined;
		const columnTsName =
			typeof context.columnTsName === "string"
				? context.columnTsName
				: undefined;
		const columnSqlName =
			typeof context.columnSqlName === "string"
				? context.columnSqlName
				: undefined;
		const constraint =
			typeof context.constraint === "string"
				? context.constraint
				: undefined;
		const detail =
			typeof context.detail === "string" ? context.detail : undefined;
		const body: StudioErrorBody = {
			error: {
				code: err.code,
				message: err.message,
				...(tableAccessor !== undefined ? { tableAccessor } : {}),
				...(columnTsName !== undefined ? { columnTsName } : {}),
				...(columnSqlName !== undefined ? { columnSqlName } : {}),
				...(constraint !== undefined ? { constraint } : {}),
				...(detail !== undefined ? { detail } : {}),
			},
		};
		if (UNAVAILABLE_CODES.has(err.code)) return { status: 503, body };
		if (CLIENT_ERROR_CODES.has(err.code)) return { status: 400, body };
		return { status: 500, body };
	}
	if (err instanceof SyntaxError) {
		return {
			status: 400,
			body: { error: { code: "invalid_json", message: err.message } },
		};
	}
	if (err instanceof Error) {
		return {
			status: 500,
			body: { error: { code: "internal", message: err.message } },
		};
	}
	return {
		status: 500,
		body: { error: { code: "internal", message: String(err) } },
	};
}
