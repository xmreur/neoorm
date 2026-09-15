import { findFkReferencedColumn } from "../../dialect/fk.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestTable,
} from "../../dialect/types.js";
import { getColumnType } from "../../plugins/registry.js";
import {
	modelTypeName,
	pascalCase,
	throughAccessors,
} from "../manifest-relations.js";
import type {
	JunctionValidation,
	TableValidation,
	ValidationConstraints,
	ValidationEnum,
	ValidationField,
	ValidationIR,
	ValidationType,
} from "./types.js";

/** `timestamps()` / `.defaultNow()` / `.updatedAt()` — ORM-owned, not client-writable. */
function isManagedTimestamp(col: ManifestColumn): boolean {
	return col.defaultNow || col.updatedAt === true;
}

function isJunctionPkColumn(
	col: ManifestColumn,
	table: ManifestTable,
	isJunction: boolean,
): boolean {
	return isJunction && table.primaryKey.includes(col.sqlName);
}

function omitOnCreate(
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

function omitOnUpdate(
	col: ManifestColumn,
	table: ManifestTable,
	isJunction: boolean,
): boolean {
	if (isJunctionPkColumn(col, table, isJunction)) {
		return true;
	}
	return col.primary || isManagedTimestamp(col);
}

function omitOnSelect(col: ManifestColumn): boolean {
	return col.hidden === true;
}

function isCreateRequired(
	col: ManifestColumn,
	table: ManifestTable,
	isJunction: boolean,
): boolean {
	if (omitOnCreate(col, table, isJunction)) {
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

function fieldConstraints(
	col: ManifestColumn,
): ValidationConstraints | undefined {
	const constraints: ValidationConstraints = {};
	const typeMaxLength = col.typeOptions?.maxLength;
	const maxLength =
		typeof typeMaxLength === "number" ? typeMaxLength : col.checkMaxLength;
	if (maxLength !== undefined) {
		constraints.maxLength = maxLength;
	}
	let minLength = col.checkMinLength;
	if (col.checkNotEmpty === true) {
		minLength = Math.max(minLength ?? 1, 1);
	}
	if (minLength !== undefined) {
		constraints.minLength = minLength;
	}
	if (col.checkMin !== undefined) {
		constraints.min = col.checkMin;
	}
	if (col.checkMax !== undefined) {
		constraints.max = col.checkMax;
	}
	if (col.checkPositive === true) {
		constraints.positive = true;
	}
	return Object.keys(constraints).length > 0 ? constraints : undefined;
}

function isTextLike(col: ManifestColumn): boolean {
	return col.kind === "text" || col.kind === "citext";
}

function isEmailColumn(col: ManifestColumn): boolean {
	if (!isTextLike(col)) {
		return false;
	}
	if (col.checkEmail === true) {
		return true;
	}
	return col.tsName === "email" || col.tsName.endsWith("Email");
}

function isUrlColumn(col: ManifestColumn): boolean {
	if (!isTextLike(col)) {
		return false;
	}
	if (col.checkUrl === true) {
		return true;
	}
	return col.tsName === "url" || col.tsName.endsWith("Url");
}

function withStringFormat(
	col: ManifestColumn,
	type: ValidationType,
): ValidationType {
	if (type.kind !== "string" || type.format !== undefined) {
		return type;
	}
	if (isEmailColumn(col)) {
		return { kind: "string", format: "email" };
	}
	if (isUrlColumn(col)) {
		return { kind: "string", format: "url" };
	}
	return type;
}

function resolveColumnType(
	col: ManifestColumn,
	manifest: Manifest,
): ValidationType {
	if (col.validation !== undefined) {
		return withStringFormat(col, col.validation);
	}
	if (col.kind === "fk") {
		const referenced = findFkReferencedColumn(col, manifest);
		if (referenced && referenced.kind !== "fk") {
			const type = getColumnType(referenced.kind)?.columnValidation?.(
				referenced,
			) ?? { kind: "unknown" };
			return withStringFormat(referenced, type);
		}
		return { kind: "string" };
	}
	const type = getColumnType(col.kind)?.columnValidation?.(col) ?? {
		kind: "unknown",
	};
	return withStringFormat(col, type);
}

function toField(
	col: ManifestColumn,
	manifest: Manifest,
	optional: boolean,
): ValidationField {
	const constraints = fieldConstraints(col);
	return {
		name: col.tsName,
		type: resolveColumnType(col, manifest),
		nullable: col.nullable,
		optional,
		...(constraints ? { constraints } : {}),
	};
}

function junctionMeta(
	table: ManifestTable,
	manifest: Manifest,
): JunctionValidation | undefined {
	const m2m = manifest.manyToMany.find(
		(link) => link.throughAccessor === table.accessor,
	);
	if (!m2m) {
		return undefined;
	}
	const pk = new Set(table.primaryKey);
	return {
		leftAccessor: m2m.leftAccessor,
		rightAccessor: m2m.rightAccessor,
		relationAs: m2m.as,
		inverseAs: m2m.inverse,
		linkColumnTsNames: table.columns
			.filter((col) => pk.has(col.sqlName))
			.map((col) => col.tsName),
	};
}

function asEnumValues(
	values: readonly string[],
): readonly [string, ...string[]] | undefined {
	const first = values[0];
	if (first === undefined) {
		return undefined;
	}
	return [first, ...values.slice(1)];
}

type InternEnum = (
	values: readonly [string, ...string[]],
	explicitName: string | undefined,
	fallbackName: string,
) => string;

function rewriteType(
	type: ValidationType,
	preferredName: string,
	intern: InternEnum,
): ValidationType {
	switch (type.kind) {
		case "enum": {
			const values = asEnumValues(type.values);
			if (!values) {
				return { kind: "string" };
			}
			const name = intern(values, type.name, preferredName);
			return { kind: "enum", values, name };
		}
		case "array":
			return {
				kind: "array",
				element: rewriteType(type.element, preferredName, intern),
			};
		case "union":
			return {
				kind: "union",
				variants: type.variants.map((variant) =>
					rewriteType(variant, preferredName, intern),
				),
			};
		case "tuple":
			return {
				kind: "tuple",
				elements: type.elements.map((element) =>
					rewriteType(element, preferredName, intern),
				),
			};
		case "object":
			return {
				kind: "object",
				fields: type.fields.map((field) => ({
					...field,
					type: rewriteType(
						field.type,
						`${preferredName}${pascalCase(field.name)}`,
						intern,
					),
				})),
			};
		case "string":
		case "number":
		case "bigint":
		case "boolean":
		case "date":
		case "unknown":
		case "literal":
		case "instance":
			return type;
		case "record":
			return {
				kind: "record",
				...(type.key !== undefined
					? {
							key: rewriteType(type.key, preferredName, intern),
						}
					: {}),
				value: rewriteType(type.value, preferredName, intern),
			};
		default: {
			const _exhaustive: never = type;
			return _exhaustive;
		}
	}
}

function rewriteField(
	field: ValidationField,
	modelName: string,
	intern: InternEnum,
): ValidationField {
	return {
		...field,
		type: rewriteType(
			field.type,
			`${modelName}${pascalCase(field.name)}`,
			intern,
		),
	};
}

function hoistEnums(tables: TableValidation[]): {
	enums: ValidationEnum[];
	tables: TableValidation[];
} {
	const usedExportNames = new Set<string>();
	for (const table of tables) {
		usedExportNames.add(`${table.modelName}Schema`);
		usedExportNames.add(`${table.modelName}CreateSchema`);
		usedExportNames.add(`${table.modelName}UpdateSchema`);
		if (table.junction !== undefined) {
			usedExportNames.add(`${table.modelName}LinkCreateSchema`);
		}
	}

	const byKey = new Map<string, ValidationEnum>();

	const intern: InternEnum = (values, explicitName, fallbackName) => {
		const key =
			explicitName !== undefined && explicitName.length > 0
				? `name:${pascalCase(explicitName)}`
				: `values:${JSON.stringify(values)}`;
		const existing = byKey.get(key);
		if (existing) {
			return existing.name;
		}

		const seed =
			explicitName !== undefined && explicitName.length > 0
				? explicitName
				: fallbackName;
		let name = pascalCase(seed.length > 0 ? seed : "Enum");
		if (usedExportNames.has(`${name}Schema`)) {
			name = `${name}Enum`;
		}
		usedExportNames.add(`${name}Schema`);
		const entry: ValidationEnum = { name, values };
		byKey.set(key, entry);
		return name;
	};

	const rewritten = tables.map((table) => ({
		...table,
		select: table.select.map((field) =>
			rewriteField(field, table.modelName, intern),
		),
		create: table.create.map((field) =>
			rewriteField(field, table.modelName, intern),
		),
		update: table.update.map((field) =>
			rewriteField(field, table.modelName, intern),
		),
	}));

	const enums = [...byKey.values()].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	return { enums, tables: rewritten };
}

/** Map a schema manifest to validator-neutral Select/Create/Update IR. */
export function validationFromManifest(manifest: Manifest): ValidationIR {
	const junctions = throughAccessors(manifest);
	const tables = Object.values(manifest.tables)
		.sort((a, b) => a.accessor.localeCompare(b.accessor))
		.map((table): TableValidation => {
			const isJunction = junctions.has(table.accessor);
			const modelName = modelTypeName(table.accessor);
			const select = table.columns
				.filter((col) => !omitOnSelect(col))
				.map((col) => toField(col, manifest, false));
			const create = table.columns
				.filter((col) => !omitOnCreate(col, table, isJunction))
				.map((col) =>
					toField(
						col,
						manifest,
						!isCreateRequired(col, table, isJunction),
					),
				);
			const update = table.columns
				.filter((col) => !omitOnUpdate(col, table, isJunction))
				.map((col) => toField(col, manifest, true));
			const junction = isJunction
				? junctionMeta(table, manifest)
				: undefined;
			return {
				accessor: table.accessor,
				modelName,
				select,
				create,
				update,
				...(junction !== undefined ? { junction } : {}),
			};
		});

	return hoistEnums(tables);
}
