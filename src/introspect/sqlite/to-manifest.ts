import { quoteIdentifier } from "../../dialect/shared.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestIndex,
	ManifestTable,
} from "../../dialect/types.js";
import type { DatabaseClient } from "../../runtime/driver.js";
import { toCamelCase } from "../../utils/case.js";

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

function tableAccessor(tableName: string): string {
	return toCamelCase(tableName.endsWith("s") ? tableName : `${tableName}s`);
}

function mapDeleteRule(rule: string): string | undefined {
	switch (rule.toUpperCase()) {
		case "CASCADE":
			return "cascade";
		case "SET NULL":
			return "set null";
		case "RESTRICT":
			return "restrict";
		case "NO ACTION":
			return "no action";
		default:
			return undefined;
	}
}

function sqliteTypeToKind(declaredType: string): ManifestColumn["kind"] {
	const t = declaredType.toUpperCase();
	if (t.includes("INT")) {
		return "int";
	}
	if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) {
		return "text";
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

function parseDefaultValue(
	value: string | null,
): { defaultValue?: unknown; defaultNow?: boolean } {
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
		fks.filter((fk) => fk.from).map((fk) => [fk.from, fk]),
	);

	const manifestColumns: ManifestColumn[] = info.map((col) => {
		const tsName = toCamelCase(col.name);
		const nullable = col.notnull === 0;
		const fk = fkMap.get(col.name);
		const defaults = parseDefaultValue(col.dflt_value);

		if (fk) {
			const onDelete = mapDeleteRule(fk.on_delete);
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
				fkTarget: `${fk.table}.${fk.to ?? "id"}`,
				...(onDelete ? { onDelete } : {}),
			};
		}

		const kind = sqliteTypeToKind(col.type);

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
			const col = manifestColumns.find((c) => c.sqlName === cols[0]?.name);
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
		const cols = (
			await client.query<IndexInfoRow>(
				`PRAGMA index_info(${quoteIdentifier(row.name)})`,
			)
		).rows;
		const columns = cols.map((col) => col.name);
		if (
			row.unique === 1 &&
			columns.length === 1 &&
			uniqueColumns.has(columns[0] ?? "")
		) {
			continue;
		}
		indexes.push({
			name: row.name,
			columns,
			unique: row.unique === 1,
		});
	}

	return {
		accessor: tableAccessor(tableName),
		sqlName: tableName,
		columns: manifestColumns,
		relations: [],
		indexes,
		primaryKey,
	};
}