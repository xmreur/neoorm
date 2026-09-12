import type {
	Manifest,
	ManifestColumn,
	ManifestTable,
} from "../dialect/types.js";
import type { DatabaseClient } from "../runtime/driver.js";
import type { ColumnNaming } from "../schema/table.js";
import {
	escapeTsString,
	resolveSqlColumnName,
	toCamelCase,
} from "../utils/case.js";
import { singularize } from "../utils/inflect.js";
import { introspectSqliteToManifest } from "./sqlite/to-manifest.js";
import { introspectToManifest } from "./to-manifest.js";

function inferFkAs(tsName: string): string {
	return tsName.replace(/_(Id|id)$/, "").replace(/Id$/, "");
}

function tableHeader(accessor: string, sqlName: string): string {
	if (sqlName === accessor) {
		return `  ${accessor}: table({`;
	}
	return `  ${accessor}: table("${escapeTsString(sqlName)}", {`;
}

const POSTGIS_KINDS = new Set(["geometry", "geography", "point"]);

const SCHEMA_IMPORT_ORDER = [
	"defineSchema",
	"table",
	"id",
	"text",
	"bool",
	"int",
	"bigint",
	"serial",
	"timestamp",
	"uuid",
	"decimal",
	"json",
	"jsonb",
	"bytea",
	"citext",
	"enumType",
	"textArray",
	"intArray",
	"fk",
	"index",
	"unique",
	"primaryKey",
] as const;

export async function introspectPostgres(
	client: DatabaseClient,
	options: { schema?: string } = {},
): Promise<string> {
	const manifest = await introspectToManifest(client, options);
	return emitPostgresSchema(manifest);
}

function emitPostgresSchema(manifest: Manifest): string {
	const usedBuilders = new Set<string>(["defineSchema", "table"]);
	const pluginColumnImports = new Set<string>();
	let needsPostgisSideEffect = false;
	const tableBlocks: string[] = [];

	for (const table of Object.values(manifest.tables)) {
		const columnNaming = inferColumnNaming(
			table.columns.map((col) => col.sqlName),
		);
		const tsNameBySql = new Map(
			table.columns.map((col) => [col.sqlName, col.tsName]),
		);
		const blockLines: string[] = [
			tableHeader(table.accessor, table.sqlName),
		];

		for (const col of table.columns) {
			if (POSTGIS_KINDS.has(col.kind)) {
				needsPostgisSideEffect = true;
				pluginColumnImports.add(col.kind);
			}
			blockLines.push(
				`    ${emitPostgresColumn(col, table, manifest, columnNaming, usedBuilders)},`,
			);
		}

		const extras = emitTableExtras(table, tsNameBySql, usedBuilders);
		blockLines.push(tableClose(columnNaming, extras));
		tableBlocks.push(blockLines.join("\n"));
	}

	const schemaImports = SCHEMA_IMPORT_ORDER.filter((name) =>
		usedBuilders.has(name),
	);
	const lines: string[] = [
		`import {`,
		...schemaImports.map((name) => `  ${name},`),
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

	lines.push(``, `export const schema = defineSchema({`);
	lines.push(...tableBlocks);
	lines.push(`});`, ``);

	return lines.join("\n");
}

function emitPostgresColumn(
	col: ManifestColumn,
	table: ManifestTable,
	manifest: Manifest,
	columnNaming: ColumnNaming,
	usedBuilders: Set<string>,
): string {
	if (col.kind === "fk") {
		usedBuilders.add("fk");
		let def = `${col.tsName}: ${emitFkBuilder(col, table, manifest)}`;
		def += emitColumnModifiers(col, table, { skipNotNullIfPrimary: true });
		return appendMapModifier(def, col.tsName, col.sqlName, columnNaming);
	}

	if (col.kind === "id") {
		usedBuilders.add("id");
		let def = `${col.tsName}: id()`;
		def += emitColumnModifiers(col, table, {
			skipPrimary: true,
			skipNotNull: true,
		});
		return appendMapModifier(def, col.tsName, col.sqlName, columnNaming);
	}

	const call = emitScalarBuilder(col, usedBuilders);
	let def = `${col.tsName}: ${call}`;
	def += emitColumnModifiers(col, table, {
		skipNotNullIfPrimary: true,
		skipNotNull: col.kind === "serial",
	});
	return appendMapModifier(def, col.tsName, col.sqlName, columnNaming);
}

function emitScalarBuilder(
	col: ManifestColumn,
	usedBuilders: Set<string>,
): string {
	if (col.kind === "uuid") {
		usedBuilders.add("uuid");
		return col.typeOptions?.version === 4
			? "uuid({ version: 4 })"
			: "uuid()";
	}

	if (col.kind === "enum") {
		usedBuilders.add("enumType");
		const values =
			(col.typeOptions?.values as readonly string[] | undefined) ?? [];
		const quoted = values.map((value) => `"${escapeTsString(value)}"`);
		const nativeName =
			col.typeOptions?.nativeTypeName ?? col.typeOptions?.name;
		const nameArg =
			typeof nativeName === "string"
				? `, { name: "${escapeTsString(nativeName)}" }`
				: "";
		return `enumType([${quoted.join(", ")}]${nameArg})`;
	}

	if (col.kind === "decimal") {
		usedBuilders.add("decimal");
		const precision = col.typeOptions?.precision;
		const scale = col.typeOptions?.scale;
		if (typeof precision === "number" && typeof scale === "number") {
			return `decimal({ precision: ${precision}, scale: ${scale} })`;
		}
		if (typeof precision === "number") {
			return `decimal({ precision: ${precision} })`;
		}
		return "decimal()";
	}

	usedBuilders.add(col.kind);
	return `${col.kind}()`;
}

function emitFkBuilder(
	col: ManifestColumn,
	table: ManifestTable,
	manifest: Manifest,
): string {
	const targetRef = resolveFkAccessorTarget(col, manifest);
	const relName = inferFkAs(col.tsName);
	let def = `fk("${escapeTsString(targetRef)}")`;
	if (col.fkAs && col.fkAs !== relName) {
		def += `.as("${escapeTsString(col.fkAs)}")`;
	}
	const defaultInverse = col.unique
		? singularize(table.accessor)
		: table.accessor;
	if (col.fkInverse && col.fkInverse !== defaultInverse) {
		def += `.inverse("${escapeTsString(col.fkInverse)}")`;
	}
	return def;
}

function emitColumnModifiers(
	col: ManifestColumn,
	table: ManifestTable,
	options: {
		skipPrimary?: boolean;
		skipNotNull?: boolean;
		skipNotNullIfPrimary?: boolean;
	} = {},
): string {
	let def = "";
	const solePrimary =
		col.primary && table.primaryKey.length === 1 && col.kind !== "id";
	if (!options.skipPrimary && solePrimary) {
		def += ".primary()";
	}
	const skipNotNull =
		options.skipNotNull || (options.skipNotNullIfPrimary && solePrimary);
	if (!skipNotNull && !col.nullable) {
		def += ".notNull()";
	}
	if (col.unique) {
		def += ".unique()";
	}
	if (col.onDelete && col.onDelete !== "no action") {
		def += `.onDelete("${escapeTsString(col.onDelete)}")`;
	}
	if (col.defaultNow) {
		def += ".defaultNow()";
	} else if (col.defaultValue !== undefined) {
		def += `.default(${formatTsValue(col.kind, col.defaultValue)})`;
	}
	if (col.checkExpression) {
		def += `.check("${escapeTsString(col.checkExpression)}")`;
	}
	return def;
}

function formatTsValue(kind: string, value: unknown): string {
	if (kind === "bigint") {
		const raw =
			typeof value === "bigint" ? value.toString() : String(value);
		if (/^-?\d+$/.test(raw)) {
			return `${raw}n`;
		}
	}
	if (kind === "json" || kind === "jsonb") {
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		return `"${escapeTsString(value)}"`;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value === null) {
		return "null";
	}
	if (typeof value === "bigint") {
		return `${value}n`;
	}
	return JSON.stringify(value);
}

function emitTableExtras(
	table: ManifestTable,
	tsNameBySql: Map<string, string>,
	usedBuilders?: Set<string>,
): string[] {
	const extras: string[] = [];
	for (const index of table.indexes) {
		const builder = index.unique ? "unique" : "index";
		usedBuilders?.add(builder);
		const cols = index.columns
			.map((sqlName) => `t.${tsNameBySql.get(sqlName) ?? sqlName}`)
			.join(", ");
		extras.push(`    ${builder}(${cols}),`);
	}
	if (table.primaryKey.length > 1) {
		usedBuilders?.add("primaryKey");
		extras.push(
			`    primaryKey(${table.primaryKey
				.map((sqlName) => `t.${tsNameBySql.get(sqlName) ?? sqlName}`)
				.join(", ")}),`,
		);
	}
	return extras;
}

function tableClose(columnNaming: ColumnNaming, extras: string[]): string {
	if (extras.length === 0) {
		if (columnNaming === "camelCase") {
			return `  }, { columnNaming: "camelCase" }),`;
		}
		return `  }),`;
	}

	const extrasBlock = extras.join("\n");
	if (columnNaming === "camelCase") {
		return `  }, {
    columnNaming: "camelCase",
    extras: (t) => [
${extrasBlock}
    ],
  }),`;
	}
	return `  }, (t) => [
${extrasBlock}
  ]),`;
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

export async function introspectSqlite(
	client: DatabaseClient,
): Promise<string> {
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

		const extras = emitTableExtras(table, tsNameBySql);

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
