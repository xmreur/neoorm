import type { Pool } from "pg";
import { pgStorageSqlType, resolvePgSchemaName } from "../dialect/postgres.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestIndex,
	ManifestTable,
} from "../dialect/types.js";
import {
	collectExtensions,
	findIntrospectColumnType,
	getPluginRegistry,
} from "../plugins/registry.js";
import { toCamelCase } from "../utils/case.js";
import {
	queryColumns,
	queryEnumTypes,
	queryForeignKeys,
	queryIndexes,
	queryInstalledExtensions,
	queryPrimaryKeyColumns,
	queryTables,
	queryUniqueConstraints,
} from "./queries.js";

function tableAccessor(tableName: string): string {
	return toCamelCase(tableName.endsWith("s") ? tableName : `${tableName}s`);
}

function isSerialColumn(
	dataType: string,
	columnDefault: string | null,
): boolean {
	if (dataType !== "integer") {
		return false;
	}
	if (!columnDefault) {
		return false;
	}
	return (
		columnDefault.includes("nextval(") ||
		columnDefault.toLowerCase().includes("generated")
	);
}

function pgTypeToKind(
	dataType: string,
	udtName: string,
	enumTypes: Record<string, string[]>,
): ManifestColumn["kind"] {
	if (enumTypes[udtName]) {
		return "enum";
	}

	const pluginType = findIntrospectColumnType(dataType, udtName);
	if (pluginType) {
		return pluginType.kind;
	}

	switch (dataType) {
		case "boolean":
			return "bool";
		case "integer":
		case "bigint":
		case "smallint":
			return "int";
		case "timestamp with time zone":
		case "timestamp without time zone":
			return "timestamp";
		default:
			return "text";
	}
}

function parseDefaultValue(
	kind: ManifestColumn["kind"],
	columnDefault: string | null,
): Pick<ManifestColumn, "defaultNow" | "defaultValue"> {
	if (!columnDefault) {
		return { defaultNow: false };
	}
	if (columnDefault.includes("now()")) {
		return { defaultNow: true };
	}
	if (kind === "bool") {
		if (columnDefault === "true")
			return { defaultNow: false, defaultValue: true };
		if (columnDefault === "false")
			return { defaultNow: false, defaultValue: false };
	}
	if (kind === "int" || kind === "decimal") {
		const match = columnDefault.match(/^(-?\d+(?:\.\d+)?)/);
		if (match) {
			return {
				defaultNow: false,
				defaultValue: kind === "int" ? Number(match[1]) : match[1],
			};
		}
	}
	if (kind === "json" || kind === "jsonb") {
		const jsonMatch = columnDefault.match(/^'((?:''|[^'])*)'::/);
		if (jsonMatch) {
			try {
				return {
					defaultNow: false,
					defaultValue: JSON.parse(jsonMatch[1]!.replace(/''/g, "'")),
				};
			} catch {
				return { defaultNow: false };
			}
		}
	}
	const stringMatch = columnDefault.match(/^'((?:''|[^'])*)'::/);
	if (stringMatch) {
		return {
			defaultNow: false,
			defaultValue: stringMatch[1]!.replace(/''/g, "'"),
		};
	}
	return { defaultNow: false };
}

function buildIndexes(
	indexRows: Awaited<ReturnType<typeof queryIndexes>>,
): ManifestIndex[] {
	const grouped = new Map<string, ManifestIndex>();

	for (const row of indexRows) {
		const existing = grouped.get(row.index_name);
		if (existing) {
			grouped.set(row.index_name, {
				...existing,
				columns: [...existing.columns, row.column_name],
			});
			continue;
		}
		grouped.set(row.index_name, {
			name: row.index_name,
			sqlName: row.index_name,
			columns: [row.column_name],
			unique: row.is_unique,
		});
	}

	return [...grouped.values()];
}

function mapDeleteRule(rule: string): string | undefined {
	switch (rule) {
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

function filterConstraintBackedIndexes(
	indexes: ManifestIndex[],
	columns: ManifestColumn[],
): ManifestIndex[] {
	const uniqueColumns = new Set(
		columns.filter((col) => col.unique).map((col) => col.sqlName),
	);

	return indexes.filter((index) => {
		if (!index.unique || index.columns.length !== 1) {
			return true;
		}
		return !uniqueColumns.has(index.columns[0]!);
	});
}

async function introspectTable(
	pool: Pool,
	tableName: string,
	enumTypes: Record<string, string[]>,
	schema: string,
): Promise<ManifestTable> {
	const [columns, fks, indexRows, uniqueRows, primaryKey] = await Promise.all(
		[
			queryColumns(pool, tableName, schema),
			queryForeignKeys(pool, tableName, schema),
			queryIndexes(pool, tableName, schema),
			queryUniqueConstraints(pool, tableName, schema),
			queryPrimaryKeyColumns(pool, tableName, schema),
		],
	);

	const fkMap = new Map(fks.map((fk) => [fk.column_name, fk]));
	const uniqueMap = new Map(
		uniqueRows.map((row) => [row.column_name, row.constraint_name]),
	);
	const pkSet = new Set(primaryKey);

	const manifestColumns: ManifestColumn[] = columns.map((col) => {
		const tsName = toCamelCase(col.column_name);
		const fk = fkMap.get(col.column_name);
		const nullable = col.is_nullable === "YES";
		const uniqueConstraintName = uniqueMap.get(col.column_name);
		const defaults = parseDefaultValue(
			fk
				? "fk"
				: isSerialColumn(col.data_type, col.column_default)
					? "serial"
					: pgTypeToKind(col.data_type, col.udt_name, enumTypes),
			col.column_default,
		);

		if (fk) {
			const onDelete = mapDeleteRule(fk.delete_rule);
			return {
				tsName,
				sqlName: col.column_name,
				kind: "fk",
				nullable,
				unique: uniqueConstraintName !== undefined,
				primary: pkSet.has(col.column_name),
				defaultNow: defaults.defaultNow,
				storageSqlType: pgStorageSqlType(col.data_type, col.udt_name),
				...(defaults.defaultValue !== undefined
					? { defaultValue: defaults.defaultValue }
					: {}),
				fkTarget: `${fk.foreign_table_name}.${fk.foreign_column_name}`,
				fkConstraintName: fk.constraint_name,
				...(uniqueConstraintName ? { uniqueConstraintName } : {}),
				...(onDelete ? { onDelete } : {}),
			};
		}

		const kind = isSerialColumn(col.data_type, col.column_default)
			? "serial"
			: col.column_name === "id" && col.udt_name === "uuid"
				? "uuid"
				: col.column_name === "id"
					? "id"
					: pgTypeToKind(col.data_type, col.udt_name, enumTypes);

		const column: ManifestColumn = {
			tsName,
			sqlName: col.column_name,
			kind,
			nullable,
			unique: uniqueConstraintName !== undefined,
			primary: pkSet.has(col.column_name),
			defaultNow: defaults.defaultNow,
			storageSqlType: pgStorageSqlType(col.data_type, col.udt_name),
			...(defaults.defaultValue !== undefined
				? { defaultValue: defaults.defaultValue }
				: {}),
			...(uniqueConstraintName ? { uniqueConstraintName } : {}),
			...(kind === "serial" ? { generated: true } : {}),
		};

		if (
			kind === "uuid" &&
			col.column_default?.includes("gen_random_uuid")
		) {
			column.typeOptions = {
				version: col.column_default.includes("uuid_generate_v4()")
					? 4
					: 7,
			};
		}

		if (kind === "enum" && enumTypes[col.udt_name]) {
			column.typeOptions = {
				values: enumTypes[col.udt_name],
				nativeTypeName: col.udt_name,
			};
		}

		return column;
	});

	return {
		accessor: tableAccessor(tableName),
		sqlName: tableName,
		columns: manifestColumns,
		relations: [],
		indexes: filterConstraintBackedIndexes(
			buildIndexes(indexRows),
			manifestColumns,
		),
		primaryKey,
	};
}

export async function introspectToManifest(
	pool: Pool,
	options: { schema?: string } = {},
): Promise<Manifest> {
	const schema = resolvePgSchemaName(options.schema);
	const tables = await queryTables(pool, schema);
	const extensions = await queryInstalledExtensions(pool);
	const enumTypes = await queryEnumTypes(pool, schema);
	const manifestTables: Record<string, ManifestTable> = {};

	for (const { table_name } of tables) {
		const table = await introspectTable(
			pool,
			table_name,
			enumTypes,
			schema,
		);
		manifestTables[table.accessor] = table;
	}

	const knownExtensions = new Set(collectExtensions(getPluginRegistry()));
	const relevantExtensions = extensions.filter((ext) =>
		knownExtensions.has(ext),
	);

	const manifestEnumTypes = Object.fromEntries(
		Object.entries(enumTypes).map(([name, values]) => [name, { values }]),
	);

	return {
		version: 1,
		tables: manifestTables,
		manyToMany: [],
		enumMode: "native",
		...(Object.keys(manifestEnumTypes).length > 0
			? { enumTypes: manifestEnumTypes }
			: {}),
		...(relevantExtensions.length > 0
			? { extensions: relevantExtensions }
			: {}),
	};
}
