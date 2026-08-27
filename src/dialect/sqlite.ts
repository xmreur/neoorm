import { getColumnTypeOrThrow } from "../plugins/registry.js";
import { parseFkTarget } from "./fk.js";
import { resolveIndexSqlName } from "./postgres.js";
import { quoteIdentifier as q, tableRef } from "./shared.js";
import type {
	ColumnAlter,
	CreateTableOptions,
	Dialect,
	Manifest,
	ManifestColumn,
	ManifestIndex,
	ManifestTable,
	OperatorMap,
	TableDiff,
} from "./types.js";

const SQLITE_INTEGER_TYPES = new Set(["int", "serial"]);
const SQLITE_TEXT_TYPES = new Set([
	"id",
	"text",
	"uuid",
	"json",
	"jsonb",
	"decimal",
	"textArray",
	"intArray",
	"citext",
	"enum",
]);

export function sqliteColumnType(
	col: ManifestColumn,
	manifest?: Manifest,
): string {
	if (col.storageSqlType) {
		return col.storageSqlType;
	}

	if (col.kind === "fk" && col.fkTarget && manifest) {
		const { tableSql, columnSql } = parseFkTarget(col.fkTarget);
		const targetTable = Object.values(manifest.tables).find(
			(table) => table.sqlName === tableSql,
		);
		const targetCol = targetTable?.columns.find(
			(column) => column.sqlName === columnSql,
		);
		if (targetCol) {
			return sqliteColumnType(targetCol, manifest);
		}
	}

	if (col.kind === "fk") {
		return "TEXT";
	}

	if (SQLITE_INTEGER_TYPES.has(col.kind)) {
		return "INTEGER";
	}
	if (SQLITE_TEXT_TYPES.has(col.kind)) {
		return "TEXT";
	}
	if (col.kind === "bool") {
		return "BOOLEAN";
	}
	if (col.kind === "timestamp") {
		return "TIMESTAMPTZ";
	}
	if (col.kind === "bytea") {
		return "BLOB";
	}
	return "TEXT";
}

function formatDefaultValue(
	col: ManifestColumn,
	dialect: Dialect,
): string | null {
	if (col.defaultNow) {
		return dialect.defaultNowExpression();
	}
	if (col.defaultValue === undefined) {
		return null;
	}

	const plugin = getColumnTypeOrThrow(col.kind);
	if (plugin.formatDefault) {
		return plugin.formatDefault(col, col.defaultValue, dialect);
	}

	return typeof col.defaultValue === "string"
		? `'${col.defaultValue.replace(/'/g, "''")}'`
		: String(col.defaultValue);
}

function columnDef(
	col: ManifestColumn,
	table: ManifestTable,
	manifest: Manifest | undefined,
	dialect: Dialect,
): string {
	const sqlType = sqliteColumnType(col, manifest);
	const parts: string[] = [];

	if (col.primary && table.primaryKey.length <= 1) {
		if (col.kind === "serial") {
			parts.push(q(col.sqlName), "INTEGER PRIMARY KEY AUTOINCREMENT");
		} else {
			parts.push(q(col.sqlName), sqlType, "PRIMARY KEY");
		}
	} else {
		parts.push(q(col.sqlName), sqlType);
		if (!col.nullable) parts.push("NOT NULL");
		if (col.unique) parts.push("UNIQUE");
	}

	const defaultSql = formatDefaultValue(col, dialect);
	if (defaultSql !== null) {
		parts.push(`DEFAULT ${defaultSql}`);
	}

	if (col.checkExpression) {
		parts.push(`CHECK (${col.checkExpression})`);
	}

	return parts.join(" ");
}

function emitCreateTable(
	table: ManifestTable,
	options: CreateTableOptions = {},
): string {
	const inlineForeignKeys = options.inlineForeignKeys ?? true;
	const manifest = options.manifest;
	const lines: string[] = [];

	for (const col of table.columns) {
		if (col.primary && table.primaryKey.length <= 1) {
			lines.push(`  ${columnDef(col, table, manifest, sqliteDialect)}`);
		} else if (!col.primary) {
			lines.push(`  ${columnDef(col, table, manifest, sqliteDialect)}`);
		}
	}

	if (table.primaryKey.length > 1) {
		const pkCols = table.primaryKey.map((c) => q(c)).join(", ");
		lines.push(`  PRIMARY KEY (${pkCols})`);
	}

	for (const idx of table.indexes) {
		if (idx.unique) {
			const cols = idx.columns.map((c) => q(c)).join(", ");
			lines.push(`  UNIQUE (${cols})`);
		}
	}

	if (inlineForeignKeys) {
		for (const col of table.columns) {
			if (col.kind === "fk" && col.fkTarget) {
				const { tableSql: targetTable, columnSql: targetCol } =
					parseFkTarget(col.fkTarget);
				const onDelete = col.onDelete
					? ` ON DELETE ${col.onDelete.toUpperCase()}`
					: "";
				lines.push(
					`  FOREIGN KEY (${q(col.sqlName)}) REFERENCES ${q(targetTable)}(${q(targetCol)})${onDelete}`,
				);
			}
		}
	}

	const body = lines.join(",\n");
	return `CREATE TABLE ${tableRef(table)} (\n${body}\n);`;
}

function emitDropTable(table: ManifestTable): string {
	return `DROP TABLE ${tableRef(table)};`;
}

function emitCreateIndex(table: ManifestTable, index: ManifestIndex): string {
	const indexName = resolveIndexSqlName(table.sqlName, index);
	const cols = index.columns.map((c) => q(c)).join(", ");
	const unique = index.unique ? "UNIQUE " : "";
	return `CREATE ${unique}INDEX ${q(indexName)} ON ${tableRef(table)} (${cols});`;
}

function emitDropIndex(indexName: string): string {
	return `DROP INDEX IF EXISTS ${q(indexName)};`;
}

function emitDropConstraint(
	_tableSqlName: string,
	_constraintName: string,
): string {
	return "";
}

function emitAddForeignKey(
	_table: ManifestTable,
	_col: ManifestColumn,
): string {
	return "";
}

function rebuildColumnCopyNames(diff: TableDiff): Array<{
	newName: string;
	oldName: string;
}> {
	const addCols = new Set(diff.addColumns?.map((col) => col.sqlName) ?? []);
	const renames = new Map(
		(diff.renameColumns ?? []).map((rename) => [rename.to, rename.from]),
	);
	const copyCols: Array<{ newName: string; oldName: string }> = [];
	for (const col of diff.table.columns) {
		if (addCols.has(col.sqlName)) continue;
		copyCols.push({
			newName: col.sqlName,
			oldName: renames.get(col.sqlName) ?? col.sqlName,
		});
	}
	return copyCols;
}

function emitRebuildSql(table: ManifestTable, diff: TableDiff): string[] {
	const newTableName = `__neoorm_${table.sqlName}_new`;
	const manifest = diff.manifest;

	const stmts: string[] = [];
	stmts.push(
		emitCreateTable(
			{ ...table, sqlName: newTableName },
			manifest
				? { inlineForeignKeys: true, manifest }
				: { inlineForeignKeys: true },
		),
	);

	const copyCols = rebuildColumnCopyNames(diff);
	if (copyCols.length > 0) {
		const insertCols = copyCols.map((col) => q(col.newName)).join(", ");
		const selectCols = copyCols.map((col) => q(col.oldName)).join(", ");
		stmts.push(
			`INSERT INTO ${q(newTableName)} (${insertCols}) SELECT ${selectCols} FROM ${tableRef(table)};`,
		);
	}

	stmts.push(`DROP TABLE ${tableRef(table)};`);
	stmts.push(`ALTER TABLE ${q(newTableName)} RENAME TO ${q(table.sqlName)};`);

	for (const index of table.indexes) {
		if (!index.unique) {
			stmts.push(
				emitCreateIndex({ ...table, sqlName: table.sqlName }, index),
			);
		}
	}

	return stmts;
}

function emitAlterTable(table: ManifestTable, diff: TableDiff): string[] {
	const needsRebuild =
		(diff.alterColumns?.length ?? 0) > 0 ||
		(diff.fkChanges?.some((change) => change.add || change.drop) ?? false);

	if (needsRebuild) {
		return emitRebuildSql(table, diff);
	}

	const stmts: string[] = [];

	if (diff.dropColumns) {
		for (const col of diff.dropColumns) {
			stmts.push(`ALTER TABLE ${tableRef(table)} DROP COLUMN ${q(col)};`);
		}
	}

	if (diff.renameColumns) {
		for (const { from, to } of diff.renameColumns) {
			stmts.push(
				`ALTER TABLE ${tableRef(table)} RENAME COLUMN ${q(from)} TO ${q(to)};`,
			);
		}
	}

	if (diff.addColumns) {
		for (const col of diff.addColumns) {
			stmts.push(
				`ALTER TABLE ${tableRef(table)} ADD COLUMN ${columnDef(col, table, diff.manifest, sqliteDialect)};`,
			);
		}
	}

	if (diff.dropIndexes) {
		for (const indexName of diff.dropIndexes) {
			stmts.push(emitDropIndex(indexName));
		}
	}

	if (diff.addIndexes) {
		for (const index of diff.addIndexes) {
			stmts.push(emitCreateIndex(table, index));
		}
	}

	return stmts;
}

function emitAlterColumn(
	table: ManifestTable,
	alter: ColumnAlter,
	manifest?: Manifest,
): string[] {
	const diff: TableDiff = {
		table,
		alterColumns: [alter],
		...(manifest ? { manifest } : {}),
	};
	return emitRebuildSql(table, diff);
}

const whereOperators: OperatorMap = {
	equals: (col, i) => `${col} = $${i}`,
	contains: (col, i) => `${col} LIKE $${i}`,
	startsWith: (col, i) => `${col} LIKE $${i}`,
	endsWith: (col, i) => `${col} LIKE $${i}`,
	search: () => {
		throw new Error("search is not supported on sqlite");
	},
	gt: (col, i) => `${col} > $${i}`,
	gte: (col, i) => `${col} >= $${i}`,
	lt: (col, i) => `${col} < $${i}`,
	lte: (col, i) => `${col} <= $${i}`,
	in: (col, i) => `${col} IN (SELECT value FROM json_each($${i}))`,
	notIn: (col, i) => `NOT (${col} IN (SELECT value FROM json_each($${i})))`,
	isNull: (col) => `${col} IS NULL`,
	isNotNull: (col) => `${col} IS NOT NULL`,
};

export const sqliteDialect: Dialect = {
	name: "sqlite",
	quoteIdentifier: q,
	tableRef: (table) => q(table.sqlName),
	columnType: sqliteColumnType,
	resolveIndexSqlName,
	emitCreateExtensions: () => [],
	emitCreateSchema: () => "",
	emitCreateEnumTypes: () => [],
	emitCreateTable,
	emitDropTable,
	emitCreateIndex,
	emitDropIndex,
	emitDropConstraint,
	emitAlterTable,
	emitAlterColumn,
	emitAddForeignKey,
	whereOperators,
	ilike: (col, i) => `LOWER(${col}) LIKE LOWER($${i})`,
	regex: () => {
		throw new Error("search is not supported on sqlite");
	},
	defaultNowExpression: () => "CURRENT_TIMESTAMP",
	emitCreateMigrationsTable: (ref) =>
		`CREATE TABLE IF NOT EXISTS ${ref} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
	castToInt: (expr) => `CAST(${expr} AS INTEGER)`,
	castToNumeric: (expr) => `CAST(${expr} AS NUMERIC)`,
	rowToJsonObject(columns, refs, _aliasExpr) {
		const entries: string[] = [];
		for (let i = 0; i < columns.length; i++) {
			const col = columns[i];
			const ref = refs[i];
			if (!col || !ref) continue;
			entries.push(`'${col.sqlName}'`, ref);
		}
		return `json_object(${entries.join(", ")})`;
	},
	jsonBuildObjectExpr(entries) {
		return `json_object(${entries.join(", ")})`;
	},
	jsonAggExpr(expr) {
		return `json_group_array(json(${expr}))`;
	},
};
