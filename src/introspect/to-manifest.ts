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
import type { DatabaseClient } from "../runtime/driver.js";
import { toCamelCase } from "../utils/case.js";
import type { CheckConstraintRow, UniqueConstraintRow } from "./queries.js";
import {
	queryCheckConstraints,
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

function isTextLikeIdKind(kind: ManifestColumn["kind"]): boolean {
	return kind === "text" || kind === "citext";
}

/** Map a Postgres information_schema column to a manifest kind. */
export function resolvePgColumnKind(
	col: {
		column_name: string;
		data_type: string;
		udt_name: string;
		column_default: string | null;
	},
	enumTypes: Record<string, string[]> = {},
): ManifestColumn["kind"] {
	if (isSerialColumn(col.data_type, col.column_default)) {
		return "serial";
	}
	const kind = pgTypeToKind(col.data_type, col.udt_name, enumTypes);
	if (col.column_name === "id" && isTextLikeIdKind(kind)) {
		return "id";
	}
	return kind;
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
		case "smallint":
			return "int";
		case "bigint":
			return "bigint";
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
	if (kind === "bigint") {
		const match = columnDefault.match(/^(-?\d+)/);
		if (match) {
			// keep the exact literal; JS numbers cannot represent int8 exactly
			return { defaultNow: false, defaultValue: match[1] };
		}
	}
	if (kind === "json" || kind === "jsonb") {
		const jsonMatch = columnDefault.match(/^'((?:''|[^'])*)'::/);
		if (jsonMatch) {
			const jsonDefault = jsonMatch[1];
			if (!jsonDefault) {
				return { defaultNow: false };
			}
			try {
				return {
					defaultNow: false,
					defaultValue: JSON.parse(jsonDefault.replace(/''/g, "'")),
				};
			} catch {
				return { defaultNow: false };
			}
		}
	}
	const stringMatch = columnDefault.match(/^'((?:''|[^'])*)'::/);
	if (stringMatch) {
		const stringDefault = stringMatch[1];
		if (!stringDefault) {
			return { defaultNow: false };
		}
		return {
			defaultNow: false,
			defaultValue: stringDefault.replace(/''/g, "'"),
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
		const indexColumn = index.columns[0];
		if (!indexColumn) {
			return true;
		}
		return !uniqueColumns.has(indexColumn);
	});
}

function singleColumnUniqueMap(
	uniqueRows: UniqueConstraintRow[],
): Map<string, string> {
	const columnsByConstraint = new Map<string, string[]>();
	for (const row of uniqueRows) {
		const columns = columnsByConstraint.get(row.constraint_name) ?? [];
		columns.push(row.column_name);
		columnsByConstraint.set(row.constraint_name, columns);
	}

	const uniqueMap = new Map<string, string>();
	for (const [constraintName, columns] of columnsByConstraint) {
		if (columns.length !== 1) {
			continue;
		}
		const columnName = columns[0];
		if (!columnName) {
			continue;
		}
		uniqueMap.set(columnName, constraintName);
	}
	return uniqueMap;
}

function unwrapOuterParens(expression: string): string {
	let current = expression.trim();
	while (current.startsWith("(") && current.endsWith(")")) {
		let depth = 0;
		let wrapsAll = true;
		for (let i = 0; i < current.length; i++) {
			const ch = current[i];
			if (ch === "(") {
				depth += 1;
			} else if (ch === ")") {
				depth -= 1;
				if (depth === 0 && i !== current.length - 1) {
					wrapsAll = false;
					break;
				}
			}
		}
		if (!wrapsAll || depth !== 0) {
			break;
		}
		current = current.slice(1, -1).trim();
	}
	return current;
}

function parseCheckDefinition(definition: string): string | undefined {
	const match = definition.trim().match(/^CHECK\s*\((.*)\)\s*$/is);
	if (!match?.[1]) {
		return undefined;
	}
	const expression = unwrapOuterParens(match[1]);
	return expression.length > 0 ? expression : undefined;
}

function applyCheckConstraints(
	columns: ManifestColumn[],
	checkRows: CheckConstraintRow[],
): void {
	const bySqlName = new Map(columns.map((col) => [col.sqlName, col]));
	for (const row of checkRows) {
		if (Number(row.column_count) !== 1 || !row.column_name) {
			continue;
		}
		const expression = parseCheckDefinition(row.definition);
		if (!expression) {
			continue;
		}
		const column = bySqlName.get(row.column_name);
		if (!column || column.kind === "enum") {
			continue;
		}
		column.checkExpression = column.checkExpression
			? `(${column.checkExpression}) AND (${expression})`
			: expression;
	}
}

async function introspectTable(
	client: DatabaseClient,
	tableName: string,
	enumTypes: Record<string, string[]>,
	schema: string,
): Promise<ManifestTable> {
	const [columns, fks, indexRows, uniqueRows, primaryKey, checkRows] =
		await Promise.all([
			queryColumns(client, tableName, schema),
			queryForeignKeys(client, tableName, schema),
			queryIndexes(client, tableName, schema),
			queryUniqueConstraints(client, tableName, schema),
			queryPrimaryKeyColumns(client, tableName, schema),
			queryCheckConstraints(client, tableName, schema),
		]);

	const fkMap = new Map(fks.map((fk) => [fk.column_name, fk]));
	const uniqueMap = singleColumnUniqueMap(uniqueRows);
	const pkSet = new Set(primaryKey);

	const manifestColumns: ManifestColumn[] = columns.map((col) => {
		const tsName = toCamelCase(col.column_name);
		const fk = fkMap.get(col.column_name);
		const nullable = col.is_nullable === "YES";
		const uniqueConstraintName = uniqueMap.get(col.column_name);
		const defaults = parseDefaultValue(
			fk ? "fk" : resolvePgColumnKind(col, enumTypes),
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

		const kind = resolvePgColumnKind(col, enumTypes);

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

	applyCheckConstraints(manifestColumns, checkRows);

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
	client: DatabaseClient,
	options: { schema?: string } = {},
): Promise<Manifest> {
	const schema = resolvePgSchemaName(options.schema);
	const tables = await queryTables(client, schema);
	const extensions = await queryInstalledExtensions(client);
	const enumTypes = await queryEnumTypes(client, schema);
	const manifestTables: Record<string, ManifestTable> = {};

	for (const { table_name } of tables) {
		const table = await introspectTable(
			client,
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
