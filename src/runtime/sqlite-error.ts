import type { Manifest, ManifestTable } from "../dialect/types.js";
import type { QueryErrorContext } from "./errors.js";
import { truncateSql } from "./pg-error.js";

export type SqliteErrorLike = {
	message: string;
	code?: string;
};

export function isSqliteError(err: unknown): err is SqliteErrorLike {
	if (!(err instanceof Error)) {
		return false;
	}
	const message = err.message;
	return (
		message.includes("SQLITE_") ||
		message.includes("constraint failed") ||
		message.includes("no such table") ||
		message.includes("no such column")
	);
}

const SCHEMA_DRIFT_PATTERNS = [
	/no such table/i,
	/no such column/i,
	/FOREIGN KEY constraint failed/i,
];

export function isSchemaDriftSqliteMessage(message: string): boolean {
	return SCHEMA_DRIFT_PATTERNS.some((pattern) => pattern.test(message));
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

function parseSqliteConstraint(message: string): {
	kind?: string;
	table?: string;
	column?: string;
} {
	const unique = message.match(
		/UNIQUE constraint failed: ([^.]+)\.(.+)/i,
	);
	if (unique?.[1] && unique[2]) {
		return { kind: "unique", table: unique[1], column: unique[2] };
	}

	const notNull = message.match(
		/NOT NULL constraint failed: ([^.]+)\.(.+)/i,
	);
	if (notNull?.[1] && notNull[2]) {
		return { kind: "not_null", table: notNull[1], column: notNull[2] };
	}

	if (/FOREIGN KEY constraint failed/i.test(message)) {
		return { kind: "foreign_key" };
	}

	const noTable = message.match(/no such table: (.+)/i);
	if (noTable?.[1]) {
		return { kind: "no_such_table", table: noTable[1] };
	}

	const noColumn = message.match(/no such column: (.+)/i);
	if (noColumn?.[1]) {
		return { kind: "no_such_column", column: noColumn[1] };
	}

	return {};
}

function headlineForSqlite(message: string, parsed: ReturnType<typeof parseSqliteConstraint>): string {
	switch (parsed.kind) {
		case "unique":
			return parsed.column
				? `duplicate value violates unique constraint on "${parsed.column}"`
				: "duplicate value violates unique constraint";
		case "not_null":
			return parsed.column
				? `null value in column "${parsed.column}" violates not-null constraint`
				: "null value violates not-null constraint";
		case "foreign_key":
			return "foreign key constraint failed";
		case "no_such_table":
			return parsed.table
				? `table "${parsed.table}" does not exist`
				: "table does not exist";
		case "no_such_column":
			return parsed.column
				? `column "${parsed.column}" does not exist`
				: "column does not exist";
		default:
			return message;
	}
}

function errorCodeForSqlite(parsed: ReturnType<typeof parseSqliteConstraint>): string | undefined {
	switch (parsed.kind) {
		case "unique":
			return "sqlite_unique_violation";
		case "not_null":
			return "sqlite_not_null_violation";
		case "foreign_key":
			return "sqlite_foreign_key_violation";
		case "no_such_table":
			return "sqlite_no_such_table";
		case "no_such_column":
			return "sqlite_no_such_column";
		default:
			return "sqlite_error";
	}
}

function suggestionsForSqlite(
	parsed: ReturnType<typeof parseSqliteConstraint>,
	table: ManifestTable | undefined,
	columnTsName?: string,
): string[] {
	const suggestions: string[] = [];

	switch (parsed.kind) {
		case "not_null":
			if (columnTsName) {
				suggestions.push(
					`Provide "${columnTsName}" in create/update input`,
				);
				const col = table?.columns.find((c) => c.tsName === columnTsName);
				if (col?.kind === "fk" && col.nullable === false) {
					suggestions.push(
						"This FK column is required because it is .notNull() in the schema",
					);
				}
			} else {
				suggestions.push(
					"A required column was omitted or set to null in the query input",
				);
			}
			break;
		case "unique":
			suggestions.push(
				"A record with the same unique value already exists",
			);
			suggestions.push(
				"Use upsert() or update an existing row instead of insert",
			);
			break;
		case "foreign_key":
			suggestions.push("The referenced parent row does not exist");
			suggestions.push(
				"Create the parent record first, or verify relation connect/write syntax",
			);
			suggestions.push(
				"Run `neoorm migrate deploy` if the schema changed recently",
			);
			break;
		case "no_such_table":
			suggestions.push(
				"The table does not exist in the database — schema may be out of date",
			);
			suggestions.push(
				"Run `neoorm migrate deploy` and regenerate the client (`neoorm generate`)",
			);
			break;
		case "no_such_column":
			suggestions.push(
				"The column does not exist in the database — schema may be out of date",
			);
			if (columnTsName && table) {
				suggestions.push(
					`In queries use the TypeScript name "${columnTsName}", not the SQL name`,
				);
			}
			suggestions.push(
				"Run `neoorm migrate deploy` and regenerate the client (`neoorm generate`)",
			);
			break;
		default:
			break;
	}

	return suggestions;
}

export function enrichSqliteError(
	err: SqliteErrorLike,
	manifest: Manifest,
	base: Pick<QueryErrorContext, "operation" | "sql"> & {
		tableAccessor?: string;
	},
): QueryErrorContext {
	const parsed = parseSqliteConstraint(err.message);
	const table =
		(base.tableAccessor ? manifest.tables[base.tableAccessor] : undefined) ??
		findTableBySqlName(manifest, parsed.table);

	let columnTsName: string | undefined;
	let columnSqlName: string | undefined;
	if (parsed.column && table) {
		const col = table.columns.find((c) => c.sqlName === parsed.column);
		columnSqlName = parsed.column;
		columnTsName = col?.tsName ?? parsed.column;
	}

	const code = errorCodeForSqlite(parsed);
	const context: QueryErrorContext = {
		operation: base.operation,
		phase: "runtime",
		sql: truncateSql(base.sql),
		detail: headlineForSqlite(err.message, parsed),
		...(code !== undefined ? { code } : {}),
	};

	const tableAccessor = base.tableAccessor ?? table?.accessor;
	if (tableAccessor !== undefined) {
		context.tableAccessor = tableAccessor;
	}

	const tableSqlName = table?.sqlName ?? parsed.table;
	if (tableSqlName !== undefined) {
		context.tableSqlName = tableSqlName;
	}

	if (columnTsName !== undefined) {
		context.columnTsName = columnTsName;
	}

	if (columnSqlName !== undefined) {
		context.columnSqlName = columnSqlName;
	}

	const suggestions = suggestionsForSqlite(parsed, table, columnTsName);
	if (suggestions.length > 0) {
		context.suggestions = suggestions;
	}

	if (isSchemaDriftSqliteMessage(err.message) && code !== undefined) {
		context.pgCode = code;
	}

	return context;
}
