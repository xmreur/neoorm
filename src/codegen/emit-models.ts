import type {
	Manifest,
	ManifestRelation,
	ManifestTable,
} from "../dialect/types.js";
import {
	buildEnumRegistry,
	columnTsType,
	type EnumRegistry,
} from "./column-ts.js";
import { effectiveRelations, modelTypeName } from "./manifest-relations.js";

function emitGeoJsonTypes(manifest: Manifest): string[] {
	const hasPostgis = (manifest.extensions ?? []).includes("postgis");
	if (!hasPostgis) return [];

	return [
		"export type GeoJsonPoint = {",
		'  type: "Point";',
		"  coordinates: [number, number] | [number, number, number];",
		"};",
		"",
		"export type GeoJsonPolygon = {",
		'  type: "Polygon";',
		"  coordinates: number[][][];",
		"};",
		"",
		"export type GeoJsonGeometry = GeoJsonPoint | GeoJsonPolygon | Record<string, unknown>;",
		"",
	];
}

function emitBaseModel(
	manifest: Manifest,
	table: ManifestTable,
	enums: EnumRegistry,
): string {
	const name = modelTypeName(table.accessor);
	const fields = table.columns
		.map(
			(col) =>
				`  ${col.tsName}: ${columnTsType(col, manifest, enums, table.accessor)};`,
		)
		.join("\n");
	return `export interface ${name} {\n${fields}\n}`;
}

function hiddenKeysType(table: ManifestTable): string {
	const hidden = table.columns
		.filter((col) => col.hidden === true)
		.map((col) => col.tsName);
	if (hidden.length === 0) {
		return "never";
	}
	return hidden.map((name) => JSON.stringify(name)).join(" | ");
}

function relationFieldType(
	rel: { name: string; targetAccessor: string; cardinality: "one" | "many" },
	targetModelName: string,
): string {
	if (rel.cardinality === "many") {
		return `  ${rel.name}?: ${targetModelName}Payload[];`;
	}
	return `  ${rel.name}?: ${targetModelName}Payload | null;`;
}

function emitPayloadType(manifest: Manifest, table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	const payloadName = `${baseName}Payload`;
	const relations = effectiveRelations(manifest, table);
	const hiddenType = hiddenKeysType(table);

	let rowType = baseName;
	if (relations.length > 0) {
		const relationFields = relations
			.map((rel) => {
				const target = manifest.tables[rel.targetAccessor];
				const targetName = target
					? modelTypeName(target.accessor)
					: modelTypeName(rel.targetAccessor);
				return relationFieldType(rel, targetName);
			})
			.join("\n");
		rowType = `${baseName} & {\n${relationFields}\n}`;
	}

	return `export type ${payloadName} = StripCapablePayload<${rowType}, ${hiddenType}>;`;
}

function emitRelationsType(manifest: Manifest, table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	const withName = `${modelTypeName(table.accessor)}With`;
	const relations = effectiveRelations(manifest, table);

	const arms: string[] = relations.map((rel) => {
		const target = manifest.tables[rel.targetAccessor];
		const targetName = target
			? modelTypeName(target.accessor)
			: modelTypeName(rel.targetAccessor);
		const value =
			rel.cardinality === "many"
				? `W[K] extends { select: infer S } ? ApplySelect<${targetName}, S>[] : ${targetName}[]`
				: `W[K] extends { select: infer S } ? ApplySelect<${targetName}, S> | null : ${targetName} | null`;
		return `K extends ${JSON.stringify(rel.name)}\n      ? ${value}`;
	});
	arms.push(
		`K extends "_count"\n      ? W[K] extends Record<string, unknown>\n        ? { [Q in keyof W[K] & string]: number }\n        : never`,
	);

	const chain = `${arms.join("\n      : ")}\n      : never`;
	return `export type ${baseName}Relations<W extends ${withName}> = {\n  [K in keyof W as W[K] extends false | undefined ? never : K]: ${chain}\n};`;
}

function emitWithIncludesType(table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	const withName = `${modelTypeName(table.accessor)}With`;
	const includesName = `${baseName}WithIncludes`;
	const relationsName = `${baseName}Relations`;

	return `export type ${includesName}<W extends ${withName} | undefined = undefined> = [W] extends [undefined] ? ${baseName} : ${baseName} & ${relationsName}<Extract<W, ${withName}>>;`;
}

function emitHiddenKeysType(table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	return `export type ${baseName}HiddenKeys = ${hiddenKeysType(table)};`;
}

function emitFindResultType(table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	const withName = `${baseName}With`;
	const hiddenName = `${baseName}HiddenKeys`;
	const relationsName = `${baseName}Relations`;

	return `export type ${baseName}FindResult<W extends ${withName} | undefined = undefined, S = undefined, O = undefined, IH = undefined> = [W] extends [undefined]
  ? [S] extends [undefined]
    ? [O] extends [undefined]
      ? IH extends true
        ? ${baseName}
        : Omit<${baseName}, ${hiddenName}>
      : Omit<${baseName}, (SelectKeys<O> & keyof ${baseName}) | (IH extends true ? never : ${hiddenName})>
    : Pick<${baseName}, SelectKeys<S> & keyof ${baseName}>
  : ([S] extends [undefined]
    ? [O] extends [undefined]
      ? IH extends true
        ? ${baseName}
        : Omit<${baseName}, ${hiddenName}>
      : Omit<${baseName}, (SelectKeys<O> & keyof ${baseName}) | (IH extends true ? never : ${hiddenName})>
    : Pick<${baseName}, SelectKeys<S> & keyof ${baseName}>) & ${relationsName}<Extract<W, ${withName}>>;`;
}

function emitCreateResultType(table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	const withName = `${baseName}With`;
	const relationsName = `${baseName}Relations`;
	return `export type ${baseName}CreateResult<W extends ${withName}> = ${baseName} & ${relationsName}<W>;`;
}

function emitMutationResultType(table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	const withName = `${baseName}With`;
	const relationsName = `${baseName}Relations`;
	return `export type ${baseName}MutationResult<W extends ${withName}> = ${baseName} & ${relationsName}<W>;`;
}

function emitQueryResultType(table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	const withName = `${baseName}With`;
	const hiddenName = `${baseName}HiddenKeys`;
	return `export type ${baseName}QueryResult<T> = T extends { with: infer W extends ${withName} }\n  ? ${baseName}FindResult<W, SelectOf<T>, OmitOf<T>, HiddenOf<T>>\n  : T extends { select: infer S }\n    ? ${baseName}FindResult<undefined, S, OmitOf<T>, HiddenOf<T>>\n    : T extends { omit: infer O }\n      ? ${baseName}FindResult<undefined, undefined, O, HiddenOf<T>>\n      : T extends { includeHidden: true }\n        ? ${baseName}\n        : Omit<${baseName}, ${hiddenName}>;`;
}

function createMinimalFor(table: ManifestTable, baseName: string): string {
	if (table.primaryKey.length === 0) return "Record<never, never>";
	const names = table.columns
		.filter((c) => table.primaryKey.includes(c.sqlName))
		.map((c) => JSON.stringify(c.tsName))
		.join(" | ");
	return `Pick<${baseName}, ${names}>`;
}

function emitCreateQueryResultType(table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	const withName = `${baseName}With`;
	const minimal = createMinimalFor(table, baseName);
	return `export type ${baseName}CreateQueryResult<T> = T extends { with: infer W extends ${withName} }\n  ? ${baseName}CreateResult<W>\n  : T extends { returnCreated: true }\n    ? ${baseName}\n    : ${minimal};`;
}

function emitUpdateQueryResultType(table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	const withName = `${baseName}With`;
	return `export type ${baseName}UpdateQueryResult<T> = T extends { with: infer W extends ${withName} }\n  ? ${baseName}MutationResult<W> | null\n  : T extends { returnUpdated: true }\n    ? ${baseName} | null\n    : Record<never, never> | null;`;
}

function emitDeleteQueryResultType(table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	const withName = `${baseName}With`;
	return `export type ${baseName}DeleteQueryResult<T> = T extends { with: infer W extends ${withName} }\n  ? ${baseName}MutationResult<W> | null\n  : T extends { returnDeleted: true }\n    ? ${baseName} | null\n    : Record<never, never> | null;`;
}

function emitUpsertQueryResultType(table: ManifestTable): string {
	const baseName = modelTypeName(table.accessor);
	const withName = `${baseName}With`;
	const includesName = `${baseName}WithIncludes`;
	return `export type ${baseName}UpsertQueryResult<T> = T extends { with: infer W extends ${withName} }\n  ? ${includesName}<W>\n  : ${baseName};`;
}

function emitRelationListType(
	rel: ManifestRelation,
	targetModelName: string,
): string {
	return rel.cardinality === "many"
		? `${targetModelName}[]`
		: `${targetModelName} | null`;
}

export function relationResultTypeFor(
	manifest: Manifest,
	table: ManifestTable,
	relationName: string,
): string {
	const rel = effectiveRelations(manifest, table).find(
		(r) => r.name === relationName,
	);
	if (!rel) return "Record<string, unknown>";
	const target = manifest.tables[rel.targetAccessor];
	const targetName = target
		? modelTypeName(target.accessor)
		: modelTypeName(rel.targetAccessor);
	return emitRelationListType(rel, targetName);
}

export function emitModelsTs(
	manifest: Manifest,
	packageImportPath = "neoorm",
): string {
	const tables = Object.values(manifest.tables).sort((a, b) =>
		a.accessor.localeCompare(b.accessor),
	);
	const enums = buildEnumRegistry(manifest);

	const withTypeNames = tables.map((t) => `${modelTypeName(t.accessor)}With`);

	const lines: string[] = [
		"// Auto-generated by neoorm generate — do not edit",
		`import type { StripCapablePayload } from "${packageImportPath}";`,
		`import type { ${withTypeNames.join(", ")} } from "./includes.js";`,
		"",
		...emitGeoJsonTypes(manifest),
		...enums.declarations.flatMap((decl) => [decl, ""]),
		"type SelectKeys<S> = S extends readonly (infer K extends PropertyKey)[]",
		"  ? K",
		"  : S extends Record<string, unknown>",
		"    ? { [K in keyof S]: S[K] extends true ? K : never }[keyof S]",
		"    : never;",
		"",
		"type ApplySelect<Row extends object, S> = Pick<",
		"  Row,",
		"  SelectKeys<S> & keyof Row",
		">;",
		"",
		"type ApplyOmit<Row extends object, O> = Omit<",
		"  Row,",
		"  SelectKeys<O> & keyof Row",
		">;",
		"",
		"type IncludeRelation<",
		"  W,",
		"  Key extends PropertyKey,",
		'  Cardinality extends "one" | "many",',
		"  TModel extends object,",
		"> = W extends { [K in Key]?: infer Inc }",
		"  ? Inc extends { select: infer S }",
		'    ? Cardinality extends "many"',
		"      ? { [P in Key]: ApplySelect<TModel, S>[] }",
		"      : { [P in Key]: ApplySelect<TModel, S> | null }",
		'    : Cardinality extends "many"',
		"      ? { [P in Key]: TModel[] }",
		"      : { [P in Key]: TModel | null }",
		"  : {};",
		"",
		"type IncludeCount<W> = W extends { _count: infer C }",
		"  ? C extends Record<string, unknown>",
		"    ? { _count: { [K in keyof C & string]: number } }",
		"    : {}",
		"  : {};",
		"",
		"type SelectOf<T> = T extends { select: infer S } ? S : undefined;",
		"",
		"type OmitOf<T> = T extends { omit: infer O } ? O : undefined;",
		"",
		"type HiddenOf<T> = T extends { includeHidden: infer IH } ? IH : undefined;",
		"",
	];

	for (const table of tables) {
		lines.push(emitBaseModel(manifest, table, enums));
		lines.push("");
	}

	for (const table of tables) {
		lines.push(emitPayloadType(manifest, table));
		lines.push("");
	}

	for (const table of tables) {
		lines.push(emitWithIncludesType(table));
		lines.push("");
	}

	for (const table of tables) {
		lines.push(emitHiddenKeysType(table));
		lines.push("");
		lines.push(emitRelationsType(manifest, table));
		lines.push("");
		lines.push(emitFindResultType(table));
		lines.push("");
		lines.push(emitCreateResultType(table));
		lines.push("");
		lines.push(emitMutationResultType(table));
		lines.push("");
		lines.push(emitQueryResultType(table));
		lines.push("");
		lines.push(emitCreateQueryResultType(table));
		lines.push("");
		lines.push(emitUpdateQueryResultType(table));
		lines.push("");
		lines.push(emitDeleteQueryResultType(table));
		lines.push("");
		lines.push(emitUpsertQueryResultType(table));
		lines.push("");
	}

	const modelEntries = tables
		.map((t) => `  ${t.accessor}: ${modelTypeName(t.accessor)};`)
		.join("\n");

	const payloadEntries = tables
		.map((t) => `  ${t.accessor}: ${modelTypeName(t.accessor)}Payload;`)
		.join("\n");

	const resultAtCases = tables
		.map((t) => {
			const withName = `${modelTypeName(t.accessor)}With`;
			const includesName = `${modelTypeName(t.accessor)}WithIncludes`;
			return `  K extends "${t.accessor}" ? ${includesName}<\n    W extends ${withName} | undefined ? W : undefined\n  >`;
		})
		.join("\n  : ");

	lines.push(`export type NeoOrmModels = {`);
	lines.push(modelEntries);
	lines.push(`};`);
	lines.push("");

	lines.push(`export type NeoOrmRowPayloads = {`);
	lines.push(payloadEntries);
	lines.push(`};`);
	lines.push("");

	lines.push(`export type NeoOrmResultAt<`);
	lines.push(`  K extends keyof NeoOrmModels,`);
	lines.push(`  W,`);
	lines.push(`> =`);
	lines.push(resultAtCases);
	lines.push(`  : never;`);
	lines.push("");

	return lines.join("\n");
}
