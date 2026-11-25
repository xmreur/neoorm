import { quoteIdentifier } from "../../dialect/shared.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestForeignKey,
	ManifestIndex,
	ManifestIndexKey,
	ManifestTable,
} from "../../dialect/types.js";
import type { DatabaseClient } from "../../runtime/driver.js";
import { schemaError } from "../../runtime/error-builders.js";
import {
	columnTsNameFromSqlName,
	tableAccessorFromSqlName,
} from "../../utils/case.js";
import { groupForeignKeyRows, mapReferentialAction } from "../group-fks.js";
import { setIntrospectedTable } from "../table-map.js";

interface TableInfoRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
	hidden?: number;
}

interface ForeignKeyRow {
	id: number;
	seq: number;
	table: string;
	from: string;
	to: string | null;
	on_update: string;
	on_delete: string;
	match: string;
}

interface IndexListRow {
	seq: number;
	name: string;
	unique: number;
	origin: string;
	partial: number;
}

interface IndexSqlRow {
	name: string;
	sql: string | null;
}

interface IndexInfoRow {
	seqno: number;
	cid: number;
	name: string;
}

function mapDeleteRule(rule: string): string | undefined {
	return mapReferentialAction(rule);
}

/**
 * Extract the trailing `WHERE <predicate>` from a `CREATE INDEX` statement
 * as stored in `sqlite_master`. Returns `undefined` for `NULL` sql
 * (auto-indexes), statements without a top-level `WHERE`, or an empty
 * predicate. The scan skips quoted identifiers (`"…"`, `` `…` ``, `[…]`),
 * `'…'` literals (with `''` escapes), and `--` / `/* … *\/` comments, so a
 * `where` inside any of them (e.g. a column literally named `"where"`)
 * can never match.
 */
export function extractPartialIndexWhere(
	createSql: string | null,
): string | undefined {
	if (!createSql) return undefined;
	const text = createSql.trim().replace(/;\s*$/, "");
	const n = text.length;
	const isWordChar = (ch: string | undefined): boolean =>
		ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
	let i = 0;
	let matchAt = -1;
	while (i < n) {
		const ch = text[i];
		if (ch === "-" && text[i + 1] === "-") {
			const end = text.indexOf("\n", i + 2);
			i = end === -1 ? n : end + 1;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? n : end + 2;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			i++;
			while (i < n) {
				if (text[i] === ch) {
					if (text[i + 1] === ch) {
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
			}
			continue;
		}
		if (ch === "[") {
			const end = text.indexOf("]", i + 1);
			i = end === -1 ? n : end + 1;
			continue;
		}
		if (
			(ch === "W" || ch === "w") &&
			text.slice(i, i + 5).toUpperCase() === "WHERE" &&
			!isWordChar(text[i - 1]) &&
			!isWordChar(text[i + 5])
		) {
			matchAt = i;
			i += 5;
			continue;
		}
		i++;
	}
	if (matchAt === -1) return undefined;
	const predicate = text.slice(matchAt + 5).trim();
	return predicate ? predicate : undefined;
}

function parseSqliteTableDeferrable(
	createSql: string | null,
): Map<number, string> {
	const result = new Map<number, string>();
	if (!createSql) return result;
	const fkBlocks = [
		...createSql.matchAll(
			/FOREIGN\s+KEY\s*\([^)]+\)\s*REFERENCES\s+[^,)]+(?:\s+ON\s+(?:DELETE|UPDATE)\s+[A-Z ]+)*(?:\s+DEFERRABLE(?:\s+INITIALLY\s+(DEFERRED|IMMEDIATE))?)?/gi,
		),
	];
	let id = 0;
	for (const match of fkBlocks) {
		const full = match[0] ?? "";
		if (/DEFERRABLE/i.test(full)) {
			result.set(
				id,
				/INITIALLY\s+DEFERRED/i.test(full) ? "deferred" : "immediate",
			);
		}
		id += 1;
	}
	return result;
}

function sqliteTypeToKind(
	declaredType: string,
	defaultNow = false,
): ManifestColumn["kind"] {
	const t = declaredType.toUpperCase();
	if (t === "DATE") {
		return "date";
	}
	if (t === "TIME") {
		return "time";
	}
	if (t === "INTERVAL") {
		return "interval";
	}
	if (t === "INET") {
		return "inet";
	}
	if (t === "CIDR") {
		return "cidr";
	}
	if (t === "XML") {
		return "xml";
	}
	if (t === "MONEY") {
		return "money";
	}
	if (t === "REAL" || t.includes("FLOA")) {
		return "real";
	}
	if (t.includes("DOUB")) {
		return "double";
	}
	if (t.includes("INT")) {
		return "int";
	}
	if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) {
		return defaultNow ? "timestamp" : "text";
	}
	if (t.includes("BLOB") || t.includes("BINARY")) {
		return "bytea";
	}
	if (t.includes("DEC") || t.includes("NUMERIC")) {
		return "decimal";
	}
	if (t.includes("BOOL")) {
		return "bool";
	}
	if (t.includes("TIMESTAMP") || t.includes("DATETIME")) {
		return "timestamp";
	}
	if (t.includes("JSON")) {
		return "jsonb";
	}
	return "text";
}

function parseDefaultValue(value: string | null): {
	defaultValue?: unknown;
	defaultNow?: boolean;
} {
	if (value === null || value === undefined) {
		return {};
	}
	const trimmed = value.trim();
	if (/^current_timestamp$/i.test(trimmed)) {
		return { defaultNow: true };
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return { defaultValue: trimmed.slice(1, -1) };
	}
	if (trimmed === "true" || trimmed === "false") {
		return { defaultValue: trimmed === "true" };
	}
	const num = Number(trimmed);
	if (Number.isFinite(num) && trimmed !== "") {
		return { defaultValue: num };
	}
	return { defaultValue: trimmed };
}

function assignSqliteStoredGenerated(
	column: ManifestColumn,
	col: TableInfoRow,
	createSql: string | null | undefined,
	tableName: string,
): void {
	if ((col.hidden ?? 0) !== 3) return;
	const expression = sqliteStoredGeneratedExpression(createSql, col.name);
	if (!expression) {
		throw schemaError(
			"invalid_column",
			`Cannot read the stored generated expression for "${tableName}"."${col.name}"`,
		);
	}
	column.generatedExpression = expression;
}

export function sqliteStoredGeneratedExpression(
	createSql: string | null | undefined,
	columnName: string,
): string | undefined {
	if (!createSql) return undefined;
	const quoted = `"${columnName.replaceAll('"', '""')}"`;
	let searchFrom = 0;
	while (searchFrom < createSql.length) {
		const idx = createSql.indexOf(quoted, searchFrom);
		if (idx < 0) return undefined;
		const rest = createSql.slice(idx + quoted.length);
		const marker = /GENERATED\s+ALWAYS\s+AS\s*\(/i.exec(rest);
		if (!marker) {
			searchFrom = idx + quoted.length;
			continue;
		}
		const start = marker.index + marker[0].length;
		let depth = 1;
		let end = start;
		for (; end < rest.length; end++) {
			const char = rest[end];
			if (char === "(") depth++;
			else if (char === ")") {
				depth--;
				if (depth === 0) break;
			}
		}
		if (depth !== 0) return undefined;
		const after = rest.slice(end + 1);
		if (!/^\s*STORED\b/i.test(after)) {
			searchFrom = idx + quoted.length;
			continue;
		}
		return rest.slice(start, end).trim();
	}
	return undefined;
}

export async function introspectSqliteToManifest(
	client: DatabaseClient,
): Promise<Manifest> {
	const tableResult = await client.query<{ name: string }>(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_neoorm_%' ORDER BY name`,
	);

	const tables: Manifest["tables"] = {};
	for (const { name } of tableResult.rows) {
		const table = await introspectSqliteTable(client, name);
		setIntrospectedTable(tables, table);
	}

	return { version: 1, tables, manyToMany: [] };
}

async function introspectSqliteTable(
	client: DatabaseClient,
	tableName: string,
): Promise<ManifestTable> {
	const info = (
		await client.query<TableInfoRow>(
			`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`,
		)
	).rows;
	const fks = (
		await client.query<ForeignKeyRow>(
			`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`,
		)
	).rows;
	const createSql = (
		await client.query<{ sql: string | null }>(
			`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = $1`,
			[tableName],
		)
	).rows[0]?.sql;
	const deferrableById = parseSqliteTableDeferrable(createSql ?? null);
	const groupedFks = groupForeignKeyRows(
		fks.map((fk) => ({
			constraintName: String(fk.id),
			columnName: fk.from,
			foreignTable: fk.table,
			foreignColumn: fk.to ?? "id",
			ordinal: fk.seq,
			onDelete: mapDeleteRule(fk.on_delete),
			onUpdate: mapDeleteRule(fk.on_update),
			deferrable: deferrableById.get(fk.id),
		})),
	);
	const indexRows = (
		await client.query<IndexListRow>(
			`PRAGMA index_list(${quoteIdentifier(tableName)})`,
		)
	).rows;

	const columns = info.filter((col) => (col.hidden ?? 0) !== 1);
	const primaryKey = columns
		.filter((col) => col.pk > 0)
		.map((col) => col.name);
	const singleIntegerPk =
		primaryKey.length === 1 &&
		columns.some((col) => col.pk > 0 && /int/i.test(col.type));

	const fkMap = new Map(
		groupedFks
			.filter((fk) => fk.columns.length === 1)
			.flatMap((fk) => {
				const col = fk.columns[0];
				return col ? [[col.columnName, fk] as const] : [];
			}),
	);

	const manifestColumns: ManifestColumn[] = columns.map((col) => {
		const tsName = columnTsNameFromSqlName(col.name);
		const nullable = col.notnull === 0;
		const fk = fkMap.get(col.name);
		const defaults = parseDefaultValue(col.dflt_value);

		if (fk) {
			const local = fk.columns[0];
			const column: ManifestColumn = {
				tsName,
				sqlName: col.name,
				kind: "fk",
				nullable,
				unique: false,
				primary: primaryKey.length === 1 && col.pk > 0,
				defaultNow: defaults.defaultNow ?? false,
				storageSqlType: col.type || "TEXT",
				...(defaults.defaultValue !== undefined
					? { defaultValue: defaults.defaultValue }
					: {}),
				fkTarget: `${local?.foreignTable}.${local?.foreignColumn ?? "id"}`,
				...(fk.onDelete ? { onDelete: fk.onDelete } : {}),
				...(fk.onUpdate ? { onUpdate: fk.onUpdate } : {}),
				...(fk.deferrable ? { deferrable: fk.deferrable } : {}),
			};
			assignSqliteStoredGenerated(column, col, createSql, tableName);
			return column;
		}

		const kind = sqliteTypeToKind(col.type, defaults.defaultNow);

		const column: ManifestColumn = {
			tsName,
			sqlName: col.name,
			kind: singleIntegerPk && col.pk > 0 ? "serial" : kind,
			nullable,
			unique: false,
			primary: primaryKey.length === 1 && col.pk > 0,
			defaultNow: defaults.defaultNow ?? false,
			storageSqlType: col.type || "TEXT",
			...(defaults.defaultValue !== undefined
				? { defaultValue: defaults.defaultValue }
				: {}),
			...(singleIntegerPk && col.pk > 0 ? { generated: true } : {}),
		};

		assignSqliteStoredGenerated(column, col, createSql, tableName);

		return column;
	});

	const uniqueAutoIndexes = indexRows.filter(
		(row) => row.origin === "u" && row.unique,
	);
	for (const row of uniqueAutoIndexes) {
		const cols = (
			await client.query<IndexInfoRow>(
				`PRAGMA index_info(${quoteIdentifier(row.name)})`,
			)
		).rows;
		if (cols.length === 1) {
			const col = manifestColumns.find(
				(c) => c.sqlName === cols[0]?.name,
			);
			if (col) {
				col.unique = true;
			}
		}
	}

	const uniqueColumns = new Set(
		manifestColumns.filter((col) => col.unique).map((col) => col.sqlName),
	);
	const indexSqlByName = new Map<string, string | null>();
	if (indexRows.length > 0) {
		const placeholders = indexRows.map((_, i) => `$${i + 1}`).join(", ");
		const sqlRows = (
			await client.query<IndexSqlRow>(
				`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders})`,
				indexRows.map((row) => row.name),
			)
		).rows;
		for (const sqlRow of sqlRows) {
			indexSqlByName.set(sqlRow.name, sqlRow.sql);
		}
	}
	const indexes: ManifestIndex[] = [];
	for (const row of indexRows) {
		if (row.origin === "pk" || row.name.startsWith("sqlite_autoindex_")) {
			continue;
		}
		const xinfo = (
			await client.query<IndexInfoRow>(
				`PRAGMA index_xinfo(${quoteIdentifier(row.name)})`,
			)
		).rows;
		const info =
			xinfo.length > 0
				? xinfo.filter((col) => col.cid !== -1)
				: (
						await client.query<IndexInfoRow>(
							`PRAGMA index_info(${quoteIdentifier(row.name)})`,
						)
					).rows;
		const keys: ManifestIndexKey[] = info.map((col) =>
			col.cid === -2 ? { expr: col.name } : { sqlName: col.name },
		);
		const columns = keys
			.map((key) => key.sqlName)
			.filter((name): name is string => Boolean(name));
		if (
			row.unique === 1 &&
			columns.length === 1 &&
			uniqueColumns.has(columns[0] ?? "") &&
			keys.every((key) => !key.expr)
		) {
			continue;
		}
		const whereSql = extractPartialIndexWhere(
			indexSqlByName.get(row.name) ?? null,
		);
		indexes.push({
			name: row.name,
			sqlName: row.name,
			columns,
			unique: row.unique === 1,
			keys,
			...(whereSql ? { whereSql } : {}),
		});
	}

	const foreignKeys: ManifestForeignKey[] = groupedFks
		.filter((fk) => fk.columns.length > 1)
		.map((fk) => {
			const manifestFk: ManifestForeignKey = {
				name: `${tableName}_${fk.columns.map((col) => col.columnName).join("_")}_fkey`,
				columns: fk.columns.map((col) => col.columnName),
				targetTable: fk.columns[0]?.foreignTable ?? "",
				targetColumns: fk.columns.map((col) => col.foreignColumn),
			};
			if (fk.onDelete) manifestFk.onDelete = fk.onDelete;
			if (fk.onUpdate) manifestFk.onUpdate = fk.onUpdate;
			if (fk.deferrable) manifestFk.deferrable = fk.deferrable;
			return manifestFk;
		});

	return {
		accessor: tableAccessorFromSqlName(tableName),
		sqlName: tableName,
		columns: manifestColumns,
		relations: [],
		indexes,
		primaryKey,
		...(foreignKeys.length > 0 ? { foreignKeys } : {}),
	};
}
