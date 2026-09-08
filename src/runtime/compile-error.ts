import { QueryErrorCode, type QueryErrorCodeValue } from "./error-codes.js";
import { queryCompileError } from "./error-builders.js";
import type { QueryOperation } from "./errors.js";

type CompileErrorOptions = {
	code?: QueryErrorCodeValue;
	operation?: QueryOperation;
	tableAccessor?: string;
	tableSqlName?: string;
	columnTsName?: string;
	suggestions?: string[];
};

/** Throw a typed query compile error. */
export function compileError(
	detail: string,
	options: CompileErrorOptions = {},
): never {
	const {
		code = QueryErrorCode.invalid_args,
		operation = "select",
		tableAccessor,
		tableSqlName,
		columnTsName,
		suggestions,
	} = options;
	throw queryCompileError(operation, detail, {
		code,
		...(tableAccessor !== undefined ? { tableAccessor } : {}),
		...(tableSqlName !== undefined ? { tableSqlName } : {}),
		...(columnTsName !== undefined ? { columnTsName } : {}),
		...(suggestions !== undefined ? { suggestions } : {}),
	});
}
