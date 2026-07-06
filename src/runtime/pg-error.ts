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

	return context;
}

export function emptyReturningContext(
	operation: Extract<QueryOperation, "insert" | "upsert">,
	manifest: Manifest,
	tableAccessor: string,
	sql: string,
): QueryErrorContext {
	const table = manifest.tables[tableAccessor];
	const context: QueryErrorContext = {
		operation,
		tableAccessor,
		sql: truncateSql(sql),
		detail: `${operation === "insert" ? "INSERT" : "UPSERT"} … RETURNING returned no row`,
	};
	if (table?.sqlName !== undefined) {
		context.tableSqlName = table.sqlName;
	}
	return context;
}
