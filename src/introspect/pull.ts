import type { DatabaseClient } from "../runtime/driver.js";
import { resolvePgSchemaName } from "../dialect/postgres.js";
import type { Manifest, ManifestColumn, ManifestTable } from "../dialect/types.js";
import { findIntrospectColumnType } from "../plugins/registry.js";
import type { ColumnNaming } from "../schema/table.js";
import {
	escapeTsString,
	resolveSqlColumnName,
	sanitizeTsIdentifier,
	toCamelCase,
} from "../utils/case.js";
import { queryColumns, queryForeignKeys, queryTables } from "./queries.js";
import { introspectSqliteToManifest } from "./sqlite/to-manifest.js";

function inferFkAs(tsName: string): string {
	return tsName.replace(/_(Id|id)$/, "").replace(/Id$/, "");
}

function singularize(word: string): string {
	if (/ies$/.test(word)) {
		return `${word.slice(0, -3)}y`;
	}
	if (/(ses|xes|zes|ches|shes)$/.test(word)) {
		return word.slice(0, -2);
	}
	if (/s$/.test(word) && !/ss$/.test(word)) {
		return word.slice(0, -1);
	}
	return word;
}

function tableHeader(accessor: string, sqlName: string): string {
	if (sqlName === accessor) {
		return `  ${accessor}: table({`;
	}
	return `  ${accessor}: table("${escapeTsString(sqlName)}", {`;
}

function tableFooter(columnNaming: ColumnNaming): string {
	if (columnNaming === "camelCase") {
		return `  }, { columnNaming: "camelCase" }),`;
	}
	return `  }),`;
}

export async function introspectPostgres(
	client: DatabaseClient,
	options: { schema?: string } = {},
): Promise<string> {
	const schema = resolvePgSchemaName(options.schema);
	const tables = await queryTables(client, schema);

	const sqlToAccessor = new Map<string, string>();
	for (const { table_name } of tables) {
		const accessor = sanitizeTsIdentifier(
			toCamelCase(table_name.endsWith("s") ? table_name : `${table_name}s`),
		);
		sqlToAccessor.set(table_name, accessor);
	}

	const pluginImports = new Set<string>();
	const pluginColumnImports = new Set<string>();
	let needsPostgisSideEffect = false;

	const tableBlocks: string[] = [];

	for (const { table_name } of tables) {
		const cols = await queryColumns(client, table_name, schema);
		const fks = await queryForeignKeys(client, table_name, schema);

		const fkMap = new Map(fks.map((r) => [r.column_name, r]));
		const columnNaming = inferColumnNaming(
			cols.map((col) => col.column_name),
		);

		const accessor = sqlToAccessor.get(table_name) ?? table_name;
		const blockLines: string[] = [tableHeader(accessor, table_name)];

		for (const col of cols) {
			const tsName = sanitizeTsIdentifier(toCamelCase(col.column_name));
			const fk = fkMap.get(col.column_name);

			if (fk) {
				const targetAccessor =
					sqlToAccessor.get(fk.foreign_table_name) ??
					sanitizeTsIdentifier(
						toCamelCase(fk.foreign_table_name),
					);
				const targetColumn = sanitizeTsIdentifier(
					toCamelCase(fk.foreign_column_name),
				);
				const targetRef =
					targetColumn === "id"
						? targetAccessor
						: `${targetAccessor}.${targetColumn}`;
				const relName = inferFkAs(tsName);
				let def = `    ${tsName}: fk("${escapeTsString(targetRef)}")`;
				if (relName !== inferFkAs(tsName)) {
					def += `.as("${escapeTsString(relName)}")`;
				}
				if (col.is_nullable === "NO") def += `.notNull()`;
				def = appendMapModifier(
					def,
					tsName,
					col.column_name,
					columnNaming,
				);
				blockLines.push(`${def},`);
			} else if (col.column_name === "id" && col.udt_name === "uuid") {
				const version = col.column_default?.includes("gen_random_uuid")
					? 4
					: 7;
				const def =
					version === 4
						? `    id: uuid({ version: 4 }).primary(),`
						: `    id: uuid().primary(),`;
				blockLines.push(def);
			} else if (col.column_name === "id") {
				blockLines.push(`    id: id(),`);
			} else {
				const pluginType = findIntrospectColumnType(
					col.data_type,
					col.udt_name,
				);
				if (pluginType) {
					if (
						pluginType.kind === "geometry" ||
						pluginType.kind === "geography" ||
						pluginType.kind === "point"
					) {
						needsPostgisSideEffect = true;
						pluginColumnImports.add(
							pluginType.kind === "geography"
								? "geography"
								: pluginType.kind === "point"
									? "point"
									: "geometry",
						);
					}
					let def = `    ${tsName}: ${pluginType.kind}()`;
					if (pluginType.kind === "uuid") {
						const version = col.column_default?.includes(
							"gen_random_uuid",
						)
							? 4
							: 7;
						def =
							version === 4
								? `    ${tsName}: uuid({ version: 4 })`
								: `    ${tsName}: uuid()`;
					}
					if (col.is_nullable === "NO") def += `.notNull()`;
					if (col.column_default?.includes("now()"))
						def += `.defaultNow()`;
					def = appendMapModifier(
						def,
						tsName,
						col.column_name,
						columnNaming,
					);
					blockLines.push(`${def},`);
				} else {
					const kind = pgTypeToKind(col.data_type);
					let def = `    ${tsName}: ${kind}()`;
					if (col.is_nullable === "NO") def += `.notNull()`;
					if (col.column_default?.includes("now()"))
						def += `.defaultNow()`;
					def = appendMapModifier(
						def,
						tsName,
						col.column_name,
						columnNaming,
					);
					blockLines.push(`${def},`);
				}
			}
		}

		blockLines.push(tableFooter(columnNaming));
		tableBlocks.push(blockLines.join("\n"));
	}

	const lines: string[] = [
		`import {`,
		`  defineSchema,`,
		`  table,`,
		`  id,`,
		`  text,`,
		`  bool,`,
		`  int,`,
		`  timestamp,`,
		`  uuid,`,
		`  fk,`,
		`  index,`,
		`  unique,`,
		`  primaryKey,`,
		`} from "neoorm/schema";`,
	];

	if (needsPostgisSideEffect) {
		lines.push(`import "neoorm/plugins/postgis";`);
	}

	if (pluginColumnImports.size > 0) {
		lines.push(
			`import { ${[...pluginColumnImports].sort().join(", ")} } from "neoorm/plugins/postgis";`,
		);
	}

	for (const pluginImport of pluginImports) {
		lines.push(pluginImport);
	}

	lines.push(``, `export const schema = defineSchema({`);
	lines.push(...tableBlocks);
	lines.push(`});`, ``);

	return lines.join("\n");
}

function sqliteColumnBuilder(col: ManifestColumn): string {
	switch (col.kind) {
		case "id":
			return "id";
		case "serial":
			return "serial";
		case "int":
			return "int";
		case "bool":
			return "bool";
		case "timestamp":
			return "timestamp";
		case "decimal":
			return "decimal";
		case "jsonb":
			return "jsonb";
		case "bytea":
			return "bytea";
		case "text":
		case "citext":
		case "enum":
		case "uuid":
		default:
			return "text";
	}
}

function resolveFkAccessorTarget(
	col: ManifestColumn,
	manifest: Manifest,
): string {
	if (!col.fkTarget) {
		return "";
	}
	const dot = col.fkTarget.indexOf(".");
	if (dot === -1) {
		return col.fkTarget;
	}
	const sqlTable = col.fkTarget.slice(0, dot);
	const sqlColumn = col.fkTarget.slice(dot + 1);
	const targetTable = Object.values(manifest.tables).find(
		(table) => table.sqlName === sqlTable,
	);
	const accessor = targetTable?.accessor ?? sqlTable;
	const targetCol = targetTable?.columns.find(
		(c) => c.sqlName === sqlColumn || c.tsName === sqlColumn,
	);
	if (targetCol?.tsName === "id") {
		return accessor;
	}
	return `${accessor}.${targetCol?.tsName ?? sqlColumn}`;
}

function sqliteColumnDef(
	col: ManifestColumn,
	table: ManifestTable,
	manifest: Manifest,
): string {
	if (col.kind === "fk" && col.fkTarget) {
		const targetRef = resolveFkAccessorTarget(col, manifest);
		const relName = inferFkAs(col.tsName);
		let def = `fk("${targetRef}")`;
		if (col.fkAs && col.fkAs !== relName) {
			def += `.as("${col.fkAs}")`;
		}
		const defaultInverse = col.unique
			? singularize(table.accessor)
			: table.accessor;
		if (col.fkInverse && col.fkInverse !== defaultInverse) {
			def += `.inverse("${col.fkInverse}")`;
		}
		if (col.onDelete) {
			def += `.onDelete("${col.onDelete}")`;
		}
		if (col.primary) {
			def += ".primary()";
		} else if (!col.nullable) {
			def += ".notNull()";
		}
		return `${col.tsName}: ${def},`;
	}

	let def = `${col.tsName}: ${sqliteColumnBuilder(col)}()`;
	if (col.kind !== "id" && col.primary && table.primaryKey.length === 1) {
		def += ".primary()";
	}
	if (col.defaultNow) {
		def += ".defaultNow()";
	}
	if (col.unique) {
		def += ".unique()";
	}
	if (!col.nullable && !col.primary) {
		def += ".notNull()";
	}
	return `${def},`;
}

export async function introspectSqlite(client: DatabaseClient): Promise<string> {
	const manifest = await introspectSqliteToManifest(client);

	const tableBlocks: string[] = [];
	for (const table of Object.values(manifest.tables)) {
		const tsNameBySql = new Map(
			table.columns.map((col) => [col.sqlName, col.tsName]),
		);
		const lines: string[] = [tableHeader(table.accessor, table.sqlName)];
		for (const col of table.columns) {
			lines.push(`    ${sqliteColumnDef(col, table, manifest)}`);
		}

		const extras: string[] = [];
		for (const index of table.indexes) {
			const builder = index.unique ? "unique" : "index";
			const cols = index.columns
				.map((sqlName) => `t.${tsNameBySql.get(sqlName) ?? sqlName}`)
				.join(", ");
			extras.push(`    ${builder}(${cols}),`);
		}
		if (table.primaryKey.length > 1) {
			extras.push(
				`    primaryKey(${table.primaryKey
					.map((sqlName) => `t.${tsNameBySql.get(sqlName) ?? sqlName}`)
					.join(", ")}),`,
			);
		}

		if (extras.length > 0) {
			lines.push(
				`  }, (t) => [
${extras.join("\n")}
  ]),`,
			);
		} else {
			lines.push(`  }),`);
		}
		tableBlocks.push(lines.join("\n"));
	}

	return [
		`import {`,
		`  defineSchema,`,
		`  table,`,
		`  id,`,
		`  text,`,
		`  bool,`,
		`  int,`,
		`  timestamp,`,
		`  decimal,`,
		`  jsonb,`,
		`  bytea,`,
		`  serial,`,
		`  fk,`,
		`  index,`,
		`  unique,`,
		`  primaryKey,`,
		`} from "neoorm/schema";`,
		``,
		`export const schema = defineSchema({`,
		...tableBlocks,
		`});`,
		``,
	].join("\n");
}

function inferColumnNaming(columnNames: string[]): ColumnNaming {
	const allCamelCase = columnNames.every(
		(sqlName) => toCamelCase(sqlName) === sqlName,
	);
	const needsSnakeCaseMap = columnNames.some(
		(sqlName) =>
			sqlName !== resolveSqlColumnName(toCamelCase(sqlName), "snakeCase"),
	);

	return allCamelCase && needsSnakeCaseMap ? "camelCase" : "snakeCase";
}

function appendMapModifier(
	def: string,
	tsName: string,
	sqlName: string,
	columnNaming: ColumnNaming,
): string {
	if (sqlName === resolveSqlColumnName(tsName, columnNaming)) {
		return def;
	}
	return `${def}.map("${escapeTsString(sqlName)}")`;
}

function pgTypeToKind(dataType: string): string {
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
