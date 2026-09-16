import { getColumnTypeOrThrow } from "../plugins/registry.js";
import { compileError } from "../runtime/compile-error.js";
import { schemaError } from "../runtime/error-builders.js";
import { QueryErrorCode, SchemaErrorCode } from "../runtime/error-codes.js";
import { findFkReferencedColumn, parseFkTarget } from "./fk.js";
import { resolveIndexSqlName } from "./postgres.js";
import { formatIndexKeyList, isSolePrimaryKeyColumn } from "./shared.js";
import type {
	ColumnAlter,
	CreateTableOptions,
	Dialect,
	DialectName,
	Manifest,
	ManifestColumn,
	ManifestIndex,
	ManifestTable,
	OperatorMap,
	TableDiff,
} from "./types.js";

const MYSQL_INDEXED_VARCHAR_LENGTH = 191;

export function quoteMysqlIdentifier(name: string): string {
	return `\`${name.replace(/`/g, "``")}\``;
}

const q = quoteMysqlIdentifier;

export type MysqlFamilyDialectOptions = {
	name: Extract<DialectName, "mysql" | "mariadb">;
	unsupportedLabel: string;
	citextCollation: string;
	dropCheckKind: "check" | "constraint";
	upsertConflictSql: (
		conflictCols: string,
		setClauses: string,
		conflictWhere?: string,
	) => string;
	excludedRef: (quotedCol: string) => string;
	search: (col: string, i: number) => string;
	regex: (col: string, i: number, insensitive: boolean) => string;
};

function tableRef(table: ManifestTable): string {
	return q(table.sqlName);
}

function sqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function enumSql(values: readonly string[]): string {
	return `ENUM(${values.map(sqlLiteral).join(", ")})`;
}

function needsIndexedVarchar(col: ManifestColumn): boolean {
	return col.primary || col.unique === true;
}

function mysqlStorageTypeNeedsIndexPrefix(typeSql: string): boolean {
	const normalized = typeSql.toUpperCase();
	if (normalized.startsWith("VARCHAR(") || normalized.startsWith("CHAR(")) {
		return false;
	}
	return (
		normalized === "TEXT" ||
		normalized === "BLOB" ||
		normalized.endsWith("TEXT") ||
		normalized.endsWith("BLOB")
	);
}

function familyColumnType(
	col: ManifestColumn,
	manifest: Manifest | undefined,
	options: MysqlFamilyDialectOptions,
): string {
	if (col.storageSqlType) {
		return col.storageSqlType;
	}

	if (col.kind === "fk" && manifest) {
		const targetCol = findFkReferencedColumn(col, manifest);
		if (targetCol && targetCol !== col) {
			if (targetCol.kind === "serial") {
				return "INT";
			}
			return familyColumnType(targetCol, manifest, options);
		}
	}

	if (col.kind === "fk") {
		return needsIndexedVarchar(col)
			? `VARCHAR(${MYSQL_INDEXED_VARCHAR_LENGTH})`
			: "TEXT";
	}

	if (
		col.kind === "geometry" ||
		col.kind === "geography" ||
		col.kind === "point"
	) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			`PostGIS column kind "${col.kind}" is not supported on ${options.unsupportedLabel}`,
		);
	}

	switch (col.kind) {
		case "id":
			return `VARCHAR(${MYSQL_INDEXED_VARCHAR_LENGTH})`;
		case "text": {
			const maxLength = col.typeOptions?.maxLength as number | undefined;
			if (maxLength !== undefined) {
				return `VARCHAR(${maxLength})`;
			}
			return needsIndexedVarchar(col)
				? `VARCHAR(${MYSQL_INDEXED_VARCHAR_LENGTH})`
				: "TEXT";
		}
		case "uuid":
			return "CHAR(36)";
		case "bool":
			return "TINYINT(1)";
		case "int":
			return "INT";
		case "bigint":
			return "BIGINT";
		case "serial":
			return "INT NOT NULL AUTO_INCREMENT";
		case "timestamp":
			return "DATETIME(6)";
		case "json":
		case "jsonb":
			return "JSON";
		case "decimal": {
			const precision = col.typeOptions?.precision as number | undefined;
			const scale = col.typeOptions?.scale as number | undefined;
			if (precision !== undefined && scale !== undefined) {
				return `DECIMAL(${precision},${scale})`;
			}
			if (precision !== undefined) {
				return `DECIMAL(${precision})`;
			}
			return "DECIMAL(65,30)";
		}
		case "bytea":
			return "BLOB";
		case "textArray":
		case "intArray":
			return "JSON";
		case "citext": {
			const maxLength = col.typeOptions?.maxLength as number | undefined;
			const width = maxLength ?? MYSQL_INDEXED_VARCHAR_LENGTH;
			return `VARCHAR(${width}) COLLATE ${options.citextCollation}`;
		}
		case "enum": {
			const values = col.typeOptions?.values as
				| readonly string[]
				| undefined;
			if (
				manifest?.enumMode === "native" &&
				values &&
				values.length > 0
			) {
				return enumSql(values);
			}
			return needsIndexedVarchar(col)
				? `VARCHAR(${MYSQL_INDEXED_VARCHAR_LENGTH})`
				: "TEXT";
		}
		default:
			return needsIndexedVarchar(col)
				? `VARCHAR(${MYSQL_INDEXED_VARCHAR_LENGTH})`
				: "TEXT";
	}
}

function mysqlIndexColumnExpr(
	table: ManifestTable,
	columnSqlName: string,
	manifest: Manifest | undefined,
	options: MysqlFamilyDialectOptions,
): string {
	const quoted = q(columnSqlName);
	const col = table.columns.find((c) => c.sqlName === columnSqlName);
	if (!col) {
		return quoted;
	}
	const typeSql = familyColumnType(col, manifest, options);
	if (mysqlStorageTypeNeedsIndexPrefix(typeSql)) {
		return `${quoted}(${MYSQL_INDEXED_VARCHAR_LENGTH})`;
	}
	return quoted;
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
		? sqlLiteral(col.defaultValue)
		: String(col.defaultValue);
}

function columnDef(
	col: ManifestColumn,
	table: ManifestTable,
	manifest: Manifest | undefined,
	dialect: Dialect,
	options: MysqlFamilyDialectOptions,
): string {
	const sqlType = familyColumnType(col, manifest, options);
	const parts: string[] = [q(col.sqlName)];

	if (isSolePrimaryKeyColumn(col, table) && col.kind === "serial") {
		parts.push("INT NOT NULL AUTO_INCREMENT PRIMARY KEY");
	} else {
		parts.push(sqlType);
		if (isSolePrimaryKeyColumn(col, table)) {
			parts.push("PRIMARY KEY");
		} else {
			if (!col.nullable && col.kind !== "serial") parts.push("NOT NULL");
			if (col.unique) parts.push("UNIQUE");
		}
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

export function createMysqlFamilyDialect(
	options: MysqlFamilyDialectOptions,
): Dialect {
	const dialect: Dialect = {
		name: options.name,
		supportsReturning: false,
		supportsXmax: false,
		quoteIdentifier: q,
		tableRef,
		columnType: (col, manifest) => familyColumnType(col, manifest, options),
		resolveIndexSqlName,
		emitCreateExtensions: () => [],
		emitCreateSchema: () => "",
		emitCreateEnumTypes: () => [],
		emitCreateTable(table, createOptions = {}) {
			return emitCreateTable(table, createOptions, dialect, options);
		},
		emitDropTable(table) {
			return `DROP TABLE ${tableRef(table)};`;
		},
		emitCreateIndex(table, index) {
			return emitCreateIndex(table, index, options);
		},
		emitDropIndex(indexName, tableSqlName) {
			if (tableSqlName) {
				return `DROP INDEX ${q(indexName)} ON ${q(tableSqlName)};`;
			}
			return `DROP INDEX ${q(indexName)};`;
		},
		emitDropConstraint(tableSqlName, constraintName) {
			return `ALTER TABLE ${q(tableSqlName)} DROP CONSTRAINT ${q(constraintName)};`;
		},
		emitAlterTable(table, diff) {
			return emitAlterTable(table, diff, dialect, options);
		},
		emitAlterColumn(table, alter, manifest) {
			return emitAlterColumn(table, alter, manifest, dialect, options);
		},
		emitAddForeignKey,
		whereOperators: familyWhereOperators(options),
		ilike: (col, i) => `LOWER(${col}) LIKE LOWER($${i})`,
		regex: options.regex,
		insertIgnoreModifier: () => "IGNORE ",
		onConflictDoNothing: () => "",
		upsertConflictSql: options.upsertConflictSql,
		excludedRef: options.excludedRef,
		defaultNowExpression: () => "CURRENT_TIMESTAMP(6)",
		emitCreateMigrationsTable: (ref) =>
			`CREATE TABLE IF NOT EXISTS ${ref} (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6))`,
		castToInt: (expr) => `CAST(${expr} AS SIGNED)`,
		castToNumeric: (expr) => `CAST(${expr} AS DECIMAL(65,30))`,
		rowToJsonObject(columns, refs, _aliasExpr) {
			const entries: string[] = [];
			for (let i = 0; i < columns.length; i++) {
				const col = columns[i];
				const ref = refs[i];
				if (!col || !ref) continue;
				entries.push(`'${col.sqlName}'`, ref);
			}
			return `JSON_OBJECT(${entries.join(", ")})`;
		},
		jsonBuildObjectExpr(entries) {
			return `JSON_OBJECT(${entries.join(", ")})`;
		},
		jsonAggExpr(expr) {
			return `JSON_ARRAYAGG(${expr})`;
		},
		jsonAggFilterExpr(expr, predicate) {
			return `JSON_ARRAYAGG(CASE WHEN ${predicate} THEN ${expr} END)`;
		},
	};
	return dialect;
}

function familyWhereOperators(options: MysqlFamilyDialectOptions): OperatorMap {
	return {
		equals: (col, i) => `${col} = $${i}`,
		contains: (col, i) => `${col} LIKE $${i}`,
		startsWith: (col, i) => `${col} LIKE $${i}`,
		endsWith: (col, i) => `${col} LIKE $${i}`,
		search: options.search,
		gt: (col, i) => `${col} > $${i}`,
		gte: (col, i) => `${col} >= $${i}`,
		lt: (col, i) => `${col} < $${i}`,
		lte: (col, i) => `${col} <= $${i}`,
		in: (col, i) =>
			`${col} IN (SELECT jt.val FROM JSON_TABLE($${i}, '$[*]' COLUMNS (val VARCHAR(512) PATH '$')) AS jt)`,
		notIn: (col, i) =>
			`NOT (${col} IN (SELECT jt.val FROM JSON_TABLE($${i}, '$[*]' COLUMNS (val VARCHAR(512) PATH '$')) AS jt))`,
		isNull: (col) => `${col} IS NULL`,
		isNotNull: (col) => `${col} IS NOT NULL`,
	};
}

function emitCreateTable(
	table: ManifestTable,
	createOptions: CreateTableOptions,
	dialect: Dialect,
	options: MysqlFamilyDialectOptions,
): string {
	const inlineForeignKeys = createOptions.inlineForeignKeys ?? true;
	const manifest = createOptions.manifest;
	const lines: string[] = [];

	for (const col of table.columns) {
		lines.push(`  ${columnDef(col, table, manifest, dialect, options)}`);
	}

	if (table.primaryKey.length > 1) {
		const pkCols = table.primaryKey.map((c) => q(c)).join(", ");
		lines.push(`  PRIMARY KEY (${pkCols})`);
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

function emitCreateIndex(
	table: ManifestTable,
	index: ManifestIndex,
	options: MysqlFamilyDialectOptions,
): string {
	if (index.whereSql) {
		compileError(
			`Partial indexes are not supported on ${options.unsupportedLabel}`,
			{
				code: QueryErrorCode.unsupported_operation,
			},
		);
	}
	if (index.using && index.using !== "btree" && index.using !== "hash") {
		compileError(
			`${options.unsupportedLabel} does not support ${index.using} indexes`,
			{
				code: QueryErrorCode.unsupported_operation,
			},
		);
	}
	const indexName = resolveIndexSqlName(table.sqlName, index);
	const cols = formatIndexKeyList(index, q, {
		formatIdent: (sqlName) =>
			mysqlIndexColumnExpr(table, sqlName, undefined, options),
		wrapExpr: (expression) => `(${expression})`,
	});
	const unique = index.unique ? "UNIQUE " : "";
	const using =
		index.using && index.using !== "btree"
			? ` USING ${index.using.toUpperCase()}`
			: "";
	return `CREATE ${unique}INDEX ${q(indexName)} ON ${tableRef(table)} (${cols})${using};`;
}

function emitAddForeignKey(table: ManifestTable, col: ManifestColumn): string {
	if (!col.fkTarget) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			`FK column "${col.sqlName}" is missing fkTarget`,
		);
	}
	const { tableSql: targetTable, columnSql: targetCol } = parseFkTarget(
		col.fkTarget,
	);
	const constraintName =
		col.fkConstraintName ?? `${table.sqlName}_${col.sqlName}_fkey`;
	const onDelete = col.onDelete
		? ` ON DELETE ${col.onDelete.toUpperCase()}`
		: "";
	return `ALTER TABLE ${tableRef(table)} ADD CONSTRAINT ${q(constraintName)} FOREIGN KEY (${q(col.sqlName)}) REFERENCES ${q(targetTable)}(${q(targetCol)})${onDelete};`;
}

function emitAlterColumn(
	table: ManifestTable,
	alter: ColumnAlter,
	manifest: Manifest | undefined,
	dialect: Dialect,
	options: MysqlFamilyDialectOptions,
): string[] {
	const stmts: string[] = [];
	const tableName = tableRef(table);
	const colName = q(alter.sqlName);

	if (alter.setType) {
		const typeSql = familyColumnType(alter.setType, manifest, options);
		const notNull =
			alter.setNullable === false ||
			(alter.setNullable === undefined && !alter.setType.nullable)
				? " NOT NULL"
				: "";
		stmts.push(
			`ALTER TABLE ${tableName} MODIFY COLUMN ${colName} ${typeSql}${notNull};`,
		);
	} else if (alter.setNullable !== undefined) {
		const existing = table.columns.find((c) => c.sqlName === alter.sqlName);
		const typeSql = existing
			? familyColumnType(existing, manifest, options)
			: "TEXT";
		stmts.push(
			alter.setNullable
				? `ALTER TABLE ${tableName} MODIFY COLUMN ${colName} ${typeSql} NULL;`
				: `ALTER TABLE ${tableName} MODIFY COLUMN ${colName} ${typeSql} NOT NULL;`,
		);
	}

	if (alter.setDefault !== undefined) {
		if (alter.setDefault === null) {
			stmts.push(
				`ALTER TABLE ${tableName} ALTER COLUMN ${colName} DROP DEFAULT;`,
			);
		} else {
			const defaultSql = formatDefaultValue(alter.setDefault, dialect);
			if (defaultSql !== null) {
				stmts.push(
					`ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET DEFAULT ${defaultSql};`,
				);
			}
		}
	}

	if (alter.dropUniqueConstraint) {
		stmts.push(
			`ALTER TABLE ${tableName} DROP INDEX ${q(alter.dropUniqueConstraint)};`,
		);
	}

	if (alter.setUnique === true) {
		const constraintName = `${table.sqlName}_${alter.sqlName}_key`;
		const indexedCol = mysqlIndexColumnExpr(
			table,
			alter.sqlName,
			manifest,
			options,
		);
		stmts.push(
			`ALTER TABLE ${tableName} ADD UNIQUE INDEX ${q(constraintName)} (${indexedCol});`,
		);
	}

	if (alter.setCheckExpression !== undefined) {
		const constraintName = `${table.sqlName}_${alter.sqlName}_check`;
		const dropKind =
			options.dropCheckKind === "check"
				? "DROP CHECK"
				: "DROP CONSTRAINT";
		stmts.push(
			`ALTER TABLE ${tableName} ${dropKind} ${q(constraintName)};`,
		);
		if (alter.setCheckExpression !== null) {
			stmts.push(
				`ALTER TABLE ${tableName} ADD CONSTRAINT ${q(constraintName)} CHECK (${alter.setCheckExpression});`,
			);
		}
	}

	return stmts;
}

function emitAlterTable(
	table: ManifestTable,
	diff: TableDiff,
	dialect: Dialect,
	options: MysqlFamilyDialectOptions,
): string[] {
	const stmts: string[] = [];
	const manifest = diff.manifest;

	if (diff.fkChanges) {
		for (const change of diff.fkChanges) {
			if (change.drop) {
				stmts.push(
					`ALTER TABLE ${tableRef(table)} DROP FOREIGN KEY ${q(change.drop)};`,
				);
			}
		}
	}

	if (diff.dropIndexes) {
		for (const indexName of diff.dropIndexes) {
			stmts.push(
				table.sqlName
					? `DROP INDEX ${q(indexName)} ON ${q(table.sqlName)};`
					: `DROP INDEX ${q(indexName)};`,
			);
		}
	}

	if (diff.dropColumns) {
		for (const col of diff.dropColumns) {
			stmts.push(`ALTER TABLE ${tableRef(table)} DROP COLUMN ${q(col)};`);
		}
	}

	if (diff.renameColumns) {
		for (const { from, to } of diff.renameColumns) {
			const nextCol = table.columns.find((c) => c.sqlName === to);
			const typeSql = nextCol
				? familyColumnType(nextCol, manifest, options)
				: "TEXT";
			stmts.push(
				`ALTER TABLE ${tableRef(table)} CHANGE COLUMN ${q(from)} ${q(to)} ${typeSql};`,
			);
		}
	}

	if (diff.addColumns) {
		for (const col of diff.addColumns) {
			stmts.push(
				`ALTER TABLE ${tableRef(table)} ADD COLUMN ${columnDef(col, table, manifest, dialect, options)};`,
			);
		}
	}

	if (diff.alterColumns) {
		for (const alter of diff.alterColumns) {
			stmts.push(
				...emitAlterColumn(table, alter, manifest, dialect, options),
			);
		}
	}

	if (diff.addIndexes) {
		for (const index of diff.addIndexes) {
			stmts.push(emitCreateIndex(table, index, options));
		}
	}

	if (diff.fkChanges) {
		for (const change of diff.fkChanges) {
			if (change.add) {
				const col = table.columns.find(
					(c) => c.sqlName === change.column,
				);
				if (col?.fkTarget) {
					const fkCol: ManifestColumn = {
						...col,
						fkTarget: change.add.target,
					};
					if (change.add.onDelete !== undefined) {
						fkCol.onDelete = change.add.onDelete;
					}
					if (change.add.constraintName !== undefined) {
						fkCol.fkConstraintName = change.add.constraintName;
					}
					stmts.push(emitAddForeignKey(table, fkCol));
				}
			}
		}
	}

	return stmts;
}
