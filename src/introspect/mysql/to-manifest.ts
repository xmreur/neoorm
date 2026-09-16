import { quoteMysqlIdentifier } from "../../dialect/mysql.js";
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

type TableRow = { table_name: string };

type ColumnRow = {
	column_name: string;
	data_type: string;
	column_type: string;
	is_nullable: string;
	column_default: string | null;
	extra: string;
	character_maximum_length: number | null;
	numeric_precision: number | null;
	numeric_scale: number | null;
	column_key: string;
};

type FkRow = {
	column_name: string;
	referenced_table_name: string;
	referenced_column_name: string;
	constraint_name: string;
	delete_rule: string;
	update_rule: string;
	ordinal_position: number;
};

type IndexRow = {
	index_name: string;
	column_name: string | null;
	non_unique: number;
	seq_in_index: number;
	index_type?: string;
	expression?: string | null;
};

type CheckRow = {
	constraint_name: string;
	check_clause: string;
};

function mapDeleteRule(rule: string): string | undefined {
	return mapReferentialAction(rule);
}

function parseEnumValues(columnType: string): string[] | undefined {
	const match = /^enum\((.*)\)$/i.exec(columnType.trim());
	if (!match?.[1]) return undefined;
	return match[1]
		.split(",")
		.map((part) => part.trim())
		.map((part) => {
			if (part.startsWith("'") && part.endsWith("'")) {
				return part.slice(1, -1).replace(/''/g, "'");
			}
			return part;
		});
}

function mysqlTypeToKind(
	row: ColumnRow,
): Pick<ManifestColumn, "kind" | "typeOptions" | "generated"> {
	const dataType = row.data_type.toLowerCase();
	const columnType = row.column_type.toLowerCase();
	const extra = row.extra.toLowerCase();

	if (dataType === "tinyint" && /^tinyint\(1\)/.test(columnType)) {
		return { kind: "bool" };
	}
	if (
		(dataType === "int" || dataType === "integer") &&
		extra.includes("auto_increment")
	) {
		return { kind: "serial", generated: true };
	}
	if (dataType === "bigint") {
		return extra.includes("auto_increment")
			? { kind: "serial", generated: true }
			: { kind: "bigint" };
	}
	if (
		dataType === "int" ||
		dataType === "integer" ||
		dataType === "mediumint"
	) {
		return { kind: "int" };
	}
	if (dataType === "float") {
		return { kind: "real" };
	}
	if (dataType === "double" || dataType === "double precision") {
		return { kind: "double" };
	}
	if (dataType === "json") {
		return { kind: "jsonb" };
	}
	if (dataType === "longtext") {
		return { kind: "text" };
	}
	if (dataType === "date") {
		return { kind: "date" };
	}
	if (dataType === "time") {
		return { kind: "time" };
	}
	if (dataType === "datetime" || dataType === "timestamp") {
		return { kind: "timestamp" };
	}
	if (
		dataType === "blob" ||
		dataType === "binary" ||
		dataType === "varbinary"
	) {
		return { kind: "bytea" };
	}
	if (dataType === "decimal" || dataType === "numeric") {
		const typeOptions: Record<string, unknown> = {};
		if (row.numeric_precision != null)
			typeOptions.precision = Number(row.numeric_precision);
		if (row.numeric_scale != null)
			typeOptions.scale = Number(row.numeric_scale);
		return {
			kind: "decimal",
			...(Object.keys(typeOptions).length > 0 ? { typeOptions } : {}),
		};
	}
	if (dataType === "enum") {
		const values = parseEnumValues(row.column_type);
		return {
			kind: "enum",
			...(values ? { typeOptions: { values } } : {}),
		};
	}
	if (dataType === "char" && row.character_maximum_length === 36) {
		return { kind: "uuid" };
	}
	if (dataType === "varchar" && row.character_maximum_length != null) {
		return {
			kind: "text",
			typeOptions: { maxLength: Number(row.character_maximum_length) },
		};
	}
	return { kind: "text" };
}

function parseDefaultValue(value: string | null): {
	defaultValue?: unknown;
	defaultNow?: boolean;
} {
	if (value === null || value === undefined) {
		return {};
	}
	const trimmed = value.trim();
	if (/^current_timestamp/i.test(trimmed)) {
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

export async function introspectMysqlToManifest(
	client: DatabaseClient,
): Promise<Manifest> {
	const tableResult = await client.query<TableRow>(
		`SELECT TABLE_NAME AS table_name
		 FROM information_schema.TABLES
		 WHERE TABLE_SCHEMA = DATABASE()
		   AND TABLE_TYPE = 'BASE TABLE'
		   AND TABLE_NAME NOT LIKE '_neoorm_%'
		 ORDER BY TABLE_NAME`,
	);

	const tables: Manifest["tables"] = {};
	for (const { table_name } of tableResult.rows) {
		const table = await introspectMysqlTable(client, table_name);
		tables[table.accessor] = table;
	}

	return { version: 1, tables, manyToMany: [] };
}

async function introspectMysqlTable(
	client: DatabaseClient,
	tableName: string,
): Promise<ManifestTable> {
	const columns = (
		await client.query<ColumnRow>(
			`SELECT COLUMN_NAME AS column_name,
			        DATA_TYPE AS data_type,
			        COLUMN_TYPE AS column_type,
			        IS_NULLABLE AS is_nullable,
			        COLUMN_DEFAULT AS column_default,
			        EXTRA AS extra,
			        CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
			        NUMERIC_PRECISION AS numeric_precision,
			        NUMERIC_SCALE AS numeric_scale,
			        COLUMN_KEY AS column_key
			 FROM information_schema.COLUMNS
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1
			 ORDER BY ORDINAL_POSITION`,
			[tableName],
		)
	).rows;

	const fks = (
		await client.query<FkRow>(
			`SELECT k.COLUMN_NAME AS column_name,
			        k.REFERENCED_TABLE_NAME AS referenced_table_name,
			        k.REFERENCED_COLUMN_NAME AS referenced_column_name,
			        k.CONSTRAINT_NAME AS constraint_name,
			        r.DELETE_RULE AS delete_rule,
			        r.UPDATE_RULE AS update_rule,
			        k.ORDINAL_POSITION AS ordinal_position
			 FROM information_schema.KEY_COLUMN_USAGE k
			 JOIN information_schema.REFERENTIAL_CONSTRAINTS r
			   ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
			  AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
			  AND r.TABLE_NAME = k.TABLE_NAME
			 WHERE k.TABLE_SCHEMA = DATABASE()
			   AND k.TABLE_NAME = $1
			   AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
			[tableName],
		)
	).rows;
	const groupedFks = groupForeignKeyRows(
		fks.map((row) => ({
			constraintName: row.constraint_name,
			columnName: row.column_name,
			foreignTable: row.referenced_table_name,
			foreignColumn: row.referenced_column_name,
			ordinal: row.ordinal_position,
			onDelete: mapDeleteRule(row.delete_rule),
			onUpdate: mapDeleteRule(row.update_rule),
		})),
	);
	const fkByColumn = new Map(
		groupedFks
			.filter((fk) => fk.columns.length === 1)
			.flatMap((fk) => {
				const col = fk.columns[0];
				return col ? [[col.columnName, fk] as const] : [];
			}),
	);

	const checks = (
		await client.query<CheckRow>(
			`SELECT tc.CONSTRAINT_NAME AS constraint_name,
			        cc.CHECK_CLAUSE AS check_clause
			 FROM information_schema.TABLE_CONSTRAINTS tc
			 JOIN information_schema.CHECK_CONSTRAINTS cc
			   ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
			  AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
			 WHERE tc.TABLE_SCHEMA = DATABASE()
			   AND tc.TABLE_NAME = $1
			   AND tc.CONSTRAINT_TYPE = 'CHECK'`,
			[tableName],
		)
	).rows;

	const indexes = await introspectMysqlIndexes(client, tableName);
	const primaryKey = columns
		.filter((col) => col.column_key === "PRI")
		.map((col) => col.column_name);

	const manifestColumns: ManifestColumn[] = columns.map((row) => {
		const mapped = mysqlTypeToKind(row);
		const defaults = parseDefaultValue(row.column_default);
		const fk = fkByColumn.get(row.column_name);
		const quotedCol = quoteMysqlIdentifier(row.column_name);
		const check = checks.find((item) =>
			item.check_clause.includes(quotedCol),
		);
		const jsonValidCheck = checks.find(
			(item) =>
				/json_valid\s*\(/i.test(item.check_clause) &&
				item.check_clause.includes(quotedCol),
		);
		const kind =
			fk !== undefined
				? "fk"
				: mapped.kind === "text" && jsonValidCheck
					? "jsonb"
					: mapped.kind;
		const column: ManifestColumn = {
			tsName: columnTsNameFromSqlName(row.column_name),
			sqlName: row.column_name,
			kind,
			nullable: row.is_nullable === "YES",
			unique: row.column_key === "UNI",
			primary: row.column_key === "PRI",
			defaultNow: defaults.defaultNow === true,
		};
		if (mapped.generated) column.generated = true;
		if (mapped.typeOptions) column.typeOptions = mapped.typeOptions;
		if (defaults.defaultValue !== undefined) {
			column.defaultValue = defaults.defaultValue;
		}
		if (fk) {
			const local = fk.columns[0];
			column.fkTarget = `${local?.foreignTable}.${local?.foreignColumn}`;
			column.fkConstraintName = fk.constraintName;
			if (fk.onDelete) column.onDelete = fk.onDelete;
			if (fk.onUpdate) column.onUpdate = fk.onUpdate;
		}
		if (
			check &&
			!(kind === "jsonb" && /json_valid\s*\(/i.test(check.check_clause))
		) {
			column.checkExpression = check.check_clause;
		}
		return column;
	});

	const foreignKeys: ManifestForeignKey[] = groupedFks
		.filter((fk) => fk.columns.length > 1)
		.map((fk) => {
			const manifestFk: ManifestForeignKey = {
				name: fk.constraintName,
				columns: fk.columns.map((col) => col.columnName),
				targetTable: fk.columns[0]?.foreignTable ?? "",
				targetColumns: fk.columns.map((col) => col.foreignColumn),
			};
			if (fk.onDelete) manifestFk.onDelete = fk.onDelete;
			if (fk.onUpdate) manifestFk.onUpdate = fk.onUpdate;
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

async function introspectMysqlIndexes(
	client: DatabaseClient,
	tableName: string,
): Promise<ManifestIndex[]> {
	const sqlWithExpr = `SELECT INDEX_NAME AS index_name,
			        COLUMN_NAME AS column_name,
			        NON_UNIQUE AS non_unique,
			        SEQ_IN_INDEX AS seq_in_index,
			        INDEX_TYPE AS index_type,
			        EXPRESSION AS expression
			 FROM information_schema.STATISTICS
			 WHERE TABLE_SCHEMA = DATABASE()
			   AND TABLE_NAME = $1
			   AND INDEX_NAME <> 'PRIMARY'
			 ORDER BY INDEX_NAME, SEQ_IN_INDEX`;
	const sqlPlain = `SELECT INDEX_NAME AS index_name,
			        COLUMN_NAME AS column_name,
			        NON_UNIQUE AS non_unique,
			        SEQ_IN_INDEX AS seq_in_index,
			        INDEX_TYPE AS index_type
			 FROM information_schema.STATISTICS
			 WHERE TABLE_SCHEMA = DATABASE()
			   AND TABLE_NAME = $1
			   AND INDEX_NAME <> 'PRIMARY'
			 ORDER BY INDEX_NAME, SEQ_IN_INDEX`;
	let rows: IndexRow[];
	try {
		rows = (await client.query<IndexRow>(sqlWithExpr, [tableName])).rows;
	} catch {
		rows = (await client.query<IndexRow>(sqlPlain, [tableName])).rows;
	}

	const grouped = new Map<string, ManifestIndex>();
	for (const row of rows) {
		const key: ManifestIndexKey = row.expression
			? { expr: row.expression }
			: { sqlName: row.column_name ?? "" };
		const using =
			row.index_type && row.index_type.toLowerCase() === "hash"
				? ("hash" as const)
				: undefined;
		const existing = grouped.get(row.index_name);
		if (existing) {
			const keys = [...(existing.keys ?? []), key];
			grouped.set(row.index_name, {
				...existing,
				keys,
				columns: keys
					.map((item) => item.sqlName)
					.filter((name): name is string => Boolean(name)),
			});
			continue;
		}
		grouped.set(row.index_name, {
			name: row.index_name,
			sqlName: row.index_name,
			columns: key.sqlName ? [key.sqlName] : [],
			unique: row.non_unique === 0,
			keys: [key],
			...(using ? { using } : {}),
		});
	}
	return [...grouped.values()];
}
