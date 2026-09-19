import { findFkReferencedColumn } from "../dialect/fk.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestTable,
} from "../dialect/types.js";
import { getColumnTypeOrThrow } from "../plugins/registry.js";
import { modelTypeName, pascalCase } from "./manifest-relations.js";
import type { ValidationType } from "./validation/types.js";

export type EnumAlias = {
	name: string;
	values: readonly string[];
	array: boolean;
};

export type EnumRegistry = {
	aliasForColumn: (accessor: string, tsName: string) => string | null;
	declarations: string[];
	byName: Map<string, EnumAlias>;
};

/** Map validator-neutral JSON/validation IR to a TypeScript type string. */
export function validationTypeToTs(type: ValidationType): string {
	switch (type.kind) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "bigint":
			return "bigint";
		case "boolean":
			return "boolean";
		case "date":
			return "Date";
		case "enum": {
			const union = type.values.map((v) => JSON.stringify(v)).join(" | ");
			return union.length > 0 ? union : "string";
		}
		case "unknown":
			return "unknown";
		case "record": {
			const value = validationTypeToTs(type.value);
			return `Record<string, ${value}>`;
		}
		case "array":
			return `${validationTypeToTs(type.element)}[]`;
		case "object": {
			if (type.fields.length === 0) return "Record<string, unknown>";
			const fields = type.fields
				.map((f) => {
					const optional = f.optional ? "?" : "";
					const ts = validationTypeToTs(f.type);
					return `${f.name}${optional}: ${ts}${f.nullable ? " | null" : ""};`;
				})
				.join(" ");
			return `{ ${fields} }`;
		}
		case "union":
			return type.variants.map((v) => validationTypeToTs(v)).join(" | ");
		case "literal":
			return JSON.stringify(type.value);
		case "tuple":
			return `[${type.elements.map((e) => validationTypeToTs(e)).join(", ")}]`;
		case "instance":
			return type.tsName;
		default: {
			const _exhaustive: never = type;
			return _exhaustive;
		}
	}
}

function enumValuesOf(col: ManifestColumn): readonly string[] | null {
	const values = col.typeOptions?.values as readonly string[] | undefined;
	if (!values || values.length === 0) return null;
	return values;
}

function enumAliasSeed(col: ManifestColumn, modelName: string): string {
	const explicit = col.typeOptions?.name as string | undefined;
	if (explicit !== undefined && explicit.length > 0) {
		return pascalCase(explicit);
	}
	return `${modelName}${pascalCase(col.tsName)}`;
}

/** Collect hoisted `export type X = ...` enum aliases for enum/enumArray columns. */
export function buildEnumRegistry(manifest: Manifest): EnumRegistry {
	const byKey = new Map<string, string>();
	const byName = new Map<string, EnumAlias>();
	const declarations: string[] = [];
	const tables = Object.values(manifest.tables).sort((a, b) =>
		a.accessor.localeCompare(b.accessor),
	);

	for (const table of tables) {
		const modelName = modelTypeName(table.accessor);
		for (const col of table.columns) {
			if (col.kind !== "enum" && col.kind !== "enumArray") continue;
			const values = enumValuesOf(col);
			if (!values) continue;
			const key = `${table.accessor}.${col.tsName}`;
			let name = enumAliasSeed(col, modelName);
			const existing = byName.get(name);
			if (existing) {
				if (
					existing.array === (col.kind === "enumArray") &&
					JSON.stringify(existing.values) === JSON.stringify(values)
				) {
					byKey.set(key, name);
					continue;
				}
				let i = 2;
				while (byName.has(`${name}${i}`)) i++;
				name = `${name}${i}`;
			}
			const union = values.map((v) => JSON.stringify(v)).join(" | ");
			const decl =
				col.kind === "enumArray"
					? `export type ${name} = (${union})[];`
					: `export type ${name} = ${union};`;
			byName.set(name, {
				name,
				values,
				array: col.kind === "enumArray",
			});
			byKey.set(key, name);
			declarations.push(decl);
		}
	}

	declarations.sort();
	return {
		aliasForColumn: (accessor, tsName) =>
			byKey.get(`${accessor}.${tsName}`) ?? null,
		declarations,
		byName,
	};
}

/**
 * Resolved TS type for a manifest column (the `resolvedType` printer).
 * Uses the plugin `columnTsType`, hoisted enum aliases, and JSON validation
 * generics — never the schema builder chain.
 */
export function columnTsType(
	col: ManifestColumn,
	manifest: Manifest,
	enums?: EnumRegistry | null,
	tableAccessor?: string,
): string {
	if (col.kind === "fk") {
		const referenced = findFkReferencedColumn(col, manifest);
		if (referenced && referenced.kind !== "fk") {
			return columnTsType(
				{ ...referenced, nullable: col.nullable },
				manifest,
				enums,
				tableAccessor,
			);
		}
		return col.nullable ? "string | null" : "string";
	}
	if (
		(col.kind === "json" || col.kind === "jsonb") &&
		col.validation !== undefined
	) {
		const base = validationTypeToTs(col.validation);
		return col.nullable ? `${base} | null` : base;
	}
	if (
		enums &&
		tableAccessor &&
		(col.kind === "enum" || col.kind === "enumArray")
	) {
		const alias = enums.aliasForColumn(tableAccessor, col.tsName);
		if (alias) {
			return col.nullable ? `${alias} | null` : alias;
		}
	}
	return getColumnTypeOrThrow(col.kind).columnTsType(col);
}

/** Non-nullable TS type for filter generic params (`StringFilter<PostStatus>`). */
export function columnNonNullTsType(
	col: ManifestColumn,
	manifest: Manifest,
	enums?: EnumRegistry | null,
	tableAccessor?: string,
): string {
	return columnTsType(
		{ ...col, nullable: false },
		manifest,
		enums,
		tableAccessor,
	);
}

/** SQL-name primary key mapped to TS names (empty when the table has no PK). */
export function pkTsNames(table: ManifestTable): string[] {
	const bySql = new Map(table.columns.map((c) => [c.sqlName, c.tsName]));
	const names: string[] = [];
	for (const sqlName of table.primaryKey) {
		const tsName = bySql.get(sqlName);
		if (tsName !== undefined) names.push(tsName);
	}
	return names;
}

function columnByTsName(
	table: ManifestTable,
	tsName: string,
): ManifestColumn | undefined {
	return table.columns.find((c) => c.tsName === tsName);
}

/**
 * Unique `where` candidates mirroring runtime `resolveUniqueConstraint`:
 * PK group, single unique/primary columns, then unique btree indexes.
 */
export function uniqueKeyCandidates(table: ManifestTable): string[][] {
	const candidates: string[][] = [];
	const pk = pkTsNames(table);
	if (pk.length > 0) candidates.push(pk);

	for (const col of table.columns) {
		if (col.unique || col.primary) {
			if (
				!candidates.some((c) => c.length === 1 && c[0] === col.tsName)
			) {
				candidates.push([col.tsName]);
			}
		}
	}

	const bySql = new Map(table.columns.map((c) => [c.sqlName, c.tsName]));
	for (const index of table.indexes) {
		if (!index.unique) continue;
		if (index.using && index.using !== "btree") continue;
		if (index.keys?.some((key) => key.expr)) continue;
		const tsNames: string[] = [];
		let ok = true;
		for (const sqlName of index.columns) {
			const tsName = bySql.get(sqlName);
			if (tsName === undefined) {
				ok = false;
				break;
			}
			tsNames.push(tsName);
		}
		if (!ok || tsNames.length === 0) continue;
		if (
			candidates.some(
				(c) =>
					c.length === tsNames.length &&
					c.every((name) => tsNames.includes(name)),
			)
		) {
			continue;
		}
		candidates.push(tsNames);
	}

	return candidates;
}

/** `timestamps()` / `.defaultNow()` / `.updatedAt()` — ORM-owned, not client-writable. */
export function isManagedTimestamp(col: ManifestColumn): boolean {
	return col.defaultNow || col.updatedAt === true;
}

export function isJunctionTable(manifest: Manifest, accessor: string): boolean {
	return manifest.manyToMany.some((m) => m.throughAccessor === accessor);
}

export function isJunctionPkColumn(
	col: ManifestColumn,
	table: ManifestTable,
	isJunction: boolean,
): boolean {
	return isJunction && table.primaryKey.includes(col.sqlName);
}

export function isOmittedOnCreate(
	col: ManifestColumn,
	table: ManifestTable,
	isJunction: boolean,
): boolean {
	if (isJunctionPkColumn(col, table, isJunction)) {
		return false;
	}
	return (
		col.primary ||
		col.generated === true ||
		col.kind === "serial" ||
		isManagedTimestamp(col)
	);
}

export function isOmittedOnUpdate(
	col: ManifestColumn,
	table: ManifestTable,
	isJunction: boolean,
): boolean {
	if (isJunctionPkColumn(col, table, isJunction)) {
		return true;
	}
	return col.primary || isManagedTimestamp(col);
}

export function isCreateRequired(
	col: ManifestColumn,
	table: ManifestTable,
	isJunction: boolean,
): boolean {
	if (isOmittedOnCreate(col, table, isJunction)) {
		return false;
	}
	// FK scalars are satisfied by relation writes (`author: { connect }`),
	// mirroring schema-driven `IsRequired` which is never true for FKs.
	if (col.kind === "fk") {
		return false;
	}
	if (col.nullable) {
		return false;
	}
	if (col.defaultNow || col.defaultValue !== undefined) {
		return false;
	}
	return true;
}

export function updateScalarTsType(
	col: ManifestColumn,
	manifest: Manifest,
	enums?: EnumRegistry | null,
	tableAccessor?: string,
): string {
	const base = columnTsType(col, manifest, enums, tableAccessor);
	const nonNull = columnNonNullTsType(col, manifest, enums, tableAccessor);
	switch (col.kind) {
		case "int":
		case "serial":
		case "real":
		case "double":
		case "bigint":
			return `${base} | { increment?: ${nonNull}; decrement?: ${nonNull}; multiply?: ${nonNull}; set?: ${base} }`;
		default:
			return `${base} | { set?: ${base} }`;
	}
}

export function columnByTsNameOrThrow(
	table: ManifestTable,
	tsName: string,
): ManifestColumn {
	const col = columnByTsName(table, tsName);
	if (!col) {
		throw new Error(
			`Column "${tsName}" not found on table "${table.accessor}"`,
		);
	}
	return col;
}
