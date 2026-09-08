import type { QueryErrorCodeValue, SchemaErrorCodeValue } from "./error-codes.js";
import {
	createQueryError,
	NeoOrmSchemaError,
	type QueryErrorContext,
	type QueryOperation,
	type SchemaErrorContext,
} from "./errors.js";

export function schemaError(
	code: SchemaErrorCodeValue,
	detail: string,
	ctx: Omit<SchemaErrorContext, "detail" | "code"> = {},
	suggestions?: string[],
	cause?: unknown,
): NeoOrmSchemaError {
	const context: SchemaErrorContext = {
		...ctx,
		code,
		detail,
		...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
	};
	return new NeoOrmSchemaError(context, cause);
}

export function queryError(
	code: QueryErrorCodeValue,
	detail: string,
	ctx: Omit<QueryErrorContext, "detail" | "code" | "phase" | "sql"> & {
		phase?: "compile" | "runtime";
		sql?: string;
	},
	suggestions?: string[],
	cause?: unknown,
) {
	const context: QueryErrorContext = {
		operation: ctx.operation,
		sql: ctx.sql ?? "",
		phase: ctx.phase ?? "compile",
		code,
		detail,
		...(ctx.tableAccessor !== undefined
			? { tableAccessor: ctx.tableAccessor }
			: {}),
		...(ctx.tableSqlName !== undefined
			? { tableSqlName: ctx.tableSqlName }
			: {}),
		...(ctx.columnTsName !== undefined
			? { columnTsName: ctx.columnTsName }
			: {}),
		...(ctx.columnSqlName !== undefined
			? { columnSqlName: ctx.columnSqlName }
			: {}),
		...(ctx.pgCode !== undefined ? { pgCode: ctx.pgCode } : {}),
		...(ctx.constraint !== undefined ? { constraint: ctx.constraint } : {}),
		...(ctx.migrationHint !== undefined
			? { migrationHint: ctx.migrationHint }
			: {}),
		...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
	};
	return createQueryError(context, cause);
}

export function queryCompileError(
	operation: QueryOperation,
	detail: string,
	options: {
		code: QueryErrorCodeValue;
		tableAccessor?: string;
		tableSqlName?: string;
		columnTsName?: string;
		suggestions?: string[];
	},
) {
	return queryError(
		options.code,
		detail,
		{
			operation,
			phase: "compile",
			...(options.tableAccessor !== undefined
				? { tableAccessor: options.tableAccessor }
				: {}),
			...(options.tableSqlName !== undefined
				? { tableSqlName: options.tableSqlName }
				: {}),
			...(options.columnTsName !== undefined
				? { columnTsName: options.columnTsName }
				: {}),
		},
		options.suggestions,
	);
}
