import { queryError } from "./error-builders.js";
import { QueryErrorCode } from "./error-codes.js";

/** Parse a JSON string from the database, or return non-string values as-is. */
export function parseDbJsonValue(
	dbValue: unknown,
	context: {
		tableAccessor?: string;
		tableSqlName?: string;
		columnTsName?: string;
		columnSqlName?: string;
	} = {},
): unknown {
	if (typeof dbValue !== "string") {
		return dbValue;
	}

	try {
		return JSON.parse(dbValue) as unknown;
	} catch (cause) {
		throw queryError(
			QueryErrorCode.invalid_input,
			"Database returned invalid JSON",
			{
				operation: "select",
				phase: "runtime",
				...(context.tableAccessor !== undefined
					? { tableAccessor: context.tableAccessor }
					: {}),
				...(context.tableSqlName !== undefined
					? { tableSqlName: context.tableSqlName }
					: {}),
				...(context.columnTsName !== undefined
					? { columnTsName: context.columnTsName }
					: {}),
				...(context.columnSqlName !== undefined
					? { columnSqlName: context.columnSqlName }
					: {}),
			},
			[
				"The stored value is not valid JSON",
				"Repair or replace the corrupt row",
			],
			cause,
		);
	}
}
