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
import {
	columnTsNameFromSqlName,
	tableAccessorFromSqlName,
} from "../../utils/case.js";
import { groupForeignKeyRows, mapReferentialAction } from "../group-fks.js";

interface TableInfoRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
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

interface IndexInfoRow {
	seqno: number;
	cid: number;
	name: string;
}

function mapDeleteRule(rule: string): string | undefined {
	return mapReferentialAction(rule);
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
	if (t.includes("INT")) {
		return "int";
	}
	if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) {
		return defaultNow ? "timestamp" : "text";
	}
	if (t.includes("BLOB") || t.includes("BINARY")) {
		return "bytea";
	}
	if (
		t.includes("REAL") ||
		t.includes("FLOA") ||
		t.includes("DOUB") ||
		t.includes("DEC") ||
		t.includes("NUMERIC")
	) {
		return "decimal";
	}
	if (t.includes("BOOL")) {
		return "bool";
	}
	if (
		t.includes("TIMESTAMP") ||
		t.includes("DATETIME") ||
		t.includes("DATE")
	) {
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

export async function introspectSqliteToManifest(
	client: DatabaseClient,
): Promise<Manifest> {
	const tableResult = await client.query<{ name: string }>(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_neoorm_%' ORDER BY name`,
	);

	const tables: Manifest["tables"] = {};
	for (const { name } of tableResult.rows) {
		const table = await introspectSqliteTable(client, name);
		tables[table.accessor] = table;
	}

	return { version: 1, tables, manyToMany: [] };
}

async function introspectSqliteTable(
	client: DatabaseClient,
	tableName: string,
): Promise<ManifestTable> {
	const info = (
		await client.query<TableInfoRow>(
			`PRAGMA table_info(${quoteIdentifier(tableName)})`,
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

	const primaryKey = info.filter((col) => col.pk > 0).map((col) => col.name);
	const singleIntegerPk =
		primaryKey.length === 1 &&
		info.some((col) => col.pk > 0 && /int/i.test(col.type));

	const fkMap = new Map(
		groupedFks
			.filter((fk) => fk.columns.length === 1)
			.flatMap((fk) => {
				const col = fk.columns[0];
				return col ? [[col.columnName, fk] as const] : [];
			}),
	);

	const manifestColumns: ManifestColumn[] = info.map((col) => {
		const tsName = columnTsNameFromSqlName(col.name);
		const nullable = col.notnull === 0;
		const fk = fkMap.get(col.name);
		const defaults = parseDefaultValue(col.dflt_value);

		if (fk) {
			const local = fk.columns[0];
			return {
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
		indexes.push({
			name: row.name,
			columns,
			unique: row.unique === 1,
			keys,
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
