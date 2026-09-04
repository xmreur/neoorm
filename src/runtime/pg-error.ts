import type { Manifest, ManifestTable } from "../dialect/types.js";
import type { QueryErrorContext, QueryOperation } from "./errors.js";

export type PgErrorLike = {
	code?: string;
	message?: string;
	detail?: string;
	table?: string;
	column?: string;
	constraint?: string;
	schema?: string;
};

export function isPgError(err: unknown): err is PgErrorLike {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		typeof (err as PgErrorLike).code === "string"
	);
}

export function truncateSql(sql: string, maxLen = 240): string {
	const collapsed = sql.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLen) {
		return collapsed;
	}
	return `${collapsed.slice(0, maxLen - 1)}…`;
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

function findTableByAccessor(
	manifest: Manifest,
	accessor: string | undefined,
): ManifestTable | undefined {
	if (!accessor) return undefined;
	return manifest.tables[accessor];
}

function resolveColumnNames(
	table: ManifestTable | undefined,
	sqlColumn: string | undefined,
): { columnTsName?: string; columnSqlName?: string } {
	if (!sqlColumn) {
		return {};
	}
	const col = table?.columns.find((c) => c.sqlName === sqlColumn);
	return {
		columnSqlName: sqlColumn,
		columnTsName: col?.tsName ?? sqlColumn,
	};
}

function headlineForPgCode(err: PgErrorLike): string {
	switch (err.code) {
		case "23502":
			return err.column
				? `null value in column "${err.column}" violates not-null constraint`
				: "null value violates not-null constraint";
		case "23505":
			return err.constraint
				? `duplicate key value violates unique constraint "${err.constraint}"`
				: "duplicate key value violates unique constraint";
		case "23503":
			return err.constraint
				? `foreign key violation on constraint "${err.constraint}"`
				: "foreign key violation";
		case "23514":
			return err.constraint
				? `check constraint "${err.constraint}" violated`
				: "check constraint violated";
		case "42P01":
			return err.message ?? "relation does not exist";
		case "42703":
			return err.column
				? `column "${err.column}" does not exist`
				: (err.message ?? "column does not exist");
		default:
			return err.message ?? "database error";
	}
}

function suggestionsForPgError(
	err: PgErrorLike,
	table: ManifestTable | undefined,
	columnTsName?: string,
): string[] {
	const suggestions: string[] = [];

	switch (err.code) {
		case "23502":
			if (columnTsName) {
				suggestions.push(
					`Provide "${columnTsName}" in create/update input`,
				);
				const col = table?.columns.find((c) => c.tsName === columnTsName);
				if (col?.kind === "fk") {
					suggestions.push(
						"Connect the related record first, or set the FK column directly",
					);
					if (col.nullable === false) {
						suggestions.push(
							"This FK column is required because it is .notNull() in the schema",
						);
					}
				}
			} else {
				suggestions.push(
					"A required column was omitted or set to null in the query input",
				);
			}
			break;
		case "23505":
			suggestions.push(
				"A record with the same unique value already exists",
			);
			suggestions.push(
				"Use upsert() or update an existing row instead of insert",
			);
			break;
		case "23503":
			suggestions.push("The referenced parent row does not exist");
			suggestions.push(
				"Create the parent record first, or verify relation connect/write syntax",
			);
			suggestions.push(
				"Run `neoorm migrate deploy` if the schema changed recently",
			);
			break;
		case "23514":
			suggestions.push(
				"A check constraint or enum value was rejected by the database",
			);
			break;
		case "42P01":
			suggestions.push(
				"The table does not exist in the database — schema may be out of date",
			);
			suggestions.push(
				"Run `neoorm migrate deploy` and regenerate the client (`neoorm generate`)",
			);
			break;
		case "42703":
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
		case "22P02":
			suggestions.push(
				"The value type does not match the column type in the database",
			);
			if (columnTsName) {
				suggestions.push(`Check the value passed for "${columnTsName}"`);
			}
			break;
		default:
			break;
	}

	return suggestions;
}

function errorCodeForPg(err: PgErrorLike): string | undefined {
	switch (err.code) {
		case "23502":
			return "pg_not_null_violation";
		case "23505":
			return "pg_unique_violation";
		case "23503":
			return "pg_foreign_key_violation";
		case "23514":
			return "pg_check_violation";
		case "42P01":
			return "pg_relation_not_found";
		case "42703":
			return "pg_column_not_found";
		case "22P02":
			return "pg_invalid_input";
		default:
			return err.code ? `pg_${err.code.toLowerCase()}` : undefined;
	}
}

const SCHEMA_DRIFT_CODES = new Set(["42P01", "42703", "23503"]);

export function isSchemaDriftPgCode(code: string | undefined): boolean {
	return code !== undefined && SCHEMA_DRIFT_CODES.has(code);
}

export function enrichPgError(
	err: PgErrorLike,
	manifest: Manifest,
	base: Pick<QueryErrorContext, "operation" | "sql"> & {
		tableAccessor?: string;
	},
): QueryErrorContext {
	const table =
		findTableByAccessor(manifest, base.tableAccessor) ??
		findTableBySqlName(manifest, err.table);

	const { columnTsName, columnSqlName } = resolveColumnNames(
		table,
		err.column,
	);

	const context: QueryErrorContext = {
		operation: base.operation,
		phase: "runtime",
		sql: truncateSql(base.sql),
		detail: err.detail
			? `${headlineForPgCode(err)} (${err.detail})`
			: headlineForPgCode(err),
	};

	const tableAccessor = base.tableAccessor ?? table?.accessor;
	if (tableAccessor !== undefined) {
		context.tableAccessor = tableAccessor;
	}

	const tableSqlName = table?.sqlName ?? err.table;
	if (tableSqlName !== undefined) {
		context.tableSqlName = tableSqlName;
	}

	if (columnTsName !== undefined) {
		context.columnTsName = columnTsName;
	}

	if (columnSqlName !== undefined) {
		context.columnSqlName = columnSqlName;
	}

	if (err.code !== undefined) {
		context.pgCode = err.code;
	}

	if (err.constraint !== undefined) {
		context.constraint = err.constraint;
	}

	const code = errorCodeForPg(err);
	if (code !== undefined) {
		context.code = code;
	}

	const suggestions = suggestionsForPgError(err, table, columnTsName);
	if (suggestions.length > 0) {
		context.suggestions = suggestions;
	}

	return context;
}

export function emptyReturningContext(
	operation: Extract<QueryOperation, "insert" | "upsert" | "findOrCreate">,
	manifest: Manifest,
	tableAccessor: string,
	sql: string,
): QueryErrorContext {
	const table = manifest.tables[tableAccessor];
	const operationLabel =
		operation === "insert"
			? "INSERT"
			: operation === "upsert"
				? "UPSERT"
				: "FIND OR CREATE";
	const context: QueryErrorContext = {
		operation,
		phase: "runtime",
		tableAccessor,
		sql: truncateSql(sql),
		detail: `${operationLabel} … RETURNING returned no row`,
		suggestions: [
			"The insert may have been blocked by a trigger or RLS policy",
			"Check database triggers and row-level security on this table",
		],
	};
	if (table?.sqlName !== undefined) {
		context.tableSqlName = table.sqlName;
	}
	return context;
}
