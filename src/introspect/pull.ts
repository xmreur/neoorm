import type { DatabaseClient } from "../runtime/driver.js";
import { resolvePgSchemaName } from "../dialect/postgres.js";
import type { ManifestColumn, ManifestTable } from "../dialect/types.js";
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

export async function introspectPostgres(
	client: DatabaseClient,
	options: { schema?: string } = {},
): Promise<string> {
	const schema = resolvePgSchemaName(options.schema);
	const tables = await queryTables(client, schema);

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

		const accessor = sanitizeTsIdentifier(
			toCamelCase(table_name.endsWith("s") ? table_name : `${table_name}s`),
		);
		const blockLines: string[] = [
			`  ${accessor}: table("${escapeTsString(table_name)}", {`,
		];

		for (const col of cols) {
			const tsName = sanitizeTsIdentifier(toCamelCase(col.column_name));
			const fk = fkMap.get(col.column_name);

			if (fk) {
				const relName = tsName.replace(/Id$/, "");
				let def = [
					`    ${tsName}: fk("${escapeTsString(fk.foreign_table_name)}.${escapeTsString(fk.foreign_column_name)}", {`,
					`      as: "${escapeTsString(relName)}",`,
					`      inverse: "${escapeTsString(accessor)}",`,
					`      nullable: ${col.is_nullable === "YES"},`,
					`    })`,
				].join("\n");
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
				blockLines.push(`    id: id.primary(),`);
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

		if (columnNaming === "camelCase") {
			blockLines.push(`  }, { columnNaming: "camelCase" }),`);
		} else {
			blockLines.push(`  }),`);
		}
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

function sqliteColumnDef(col: ManifestColumn, table: ManifestTable): string {
	if (col.kind === "fk" && col.fkTarget) {
		const relName = col.tsName.replace(/Id$/, "");
		let def = `fk("${col.fkTarget}", {\n      as: "${relName}",\n      inverse: "${table.accessor}",\n      nullable: ${col.nullable},`;
		if (col.onDelete) {
			def += `\n      onDelete: "${col.onDelete}",`;
		}
		def += `\n    })`;
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
		const lines: string[] = [
			`  ${table.accessor}: table("${table.sqlName}", {`,
		];
		for (const col of table.columns) {
			lines.push(`    ${sqliteColumnDef(col, table)}`);
		}

		const extras: string[] = [];
		for (const index of table.indexes) {
			const builder = index.unique ? "unique" : "index";
			extras.push(
				`    ${index.name}: ${builder}().on(${index.columns
					.map((sqlName) => `t.${tsNameBySql.get(sqlName) ?? sqlName}`)
					.join(", ")}),`,
			);
		}
		if (table.primaryKey.length > 1) {
			extras.push(
				`    pk: primaryKey(${table.primaryKey
					.map((sqlName) => `t.${tsNameBySql.get(sqlName) ?? sqlName}`)
					.join(", ")}),`,
			);
		}

		if (extras.length > 0) {
			lines.push(
				`  }, (t) => ({
${extras.join("\n")}
  })),`,
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
