import { findFkReferencedColumn } from "../dialect/fk.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestTable,
} from "../dialect/types.js";
import {
	buildEnumRegistry,
	columnNonNullTsType,
	columnTsType,
	type EnumRegistry,
	isCreateRequired,
	isJunctionTable,
	isOmittedOnCreate,
	isOmittedOnUpdate,
	pkTsNames,
	uniqueKeyCandidates,
	updateScalarTsType,
} from "./column-ts.js";
import { effectiveRelations, modelTypeName } from "./manifest-relations.js";

const STRING_FILTER_KINDS = new Set([
	"id",
	"text",
	"citext",
	"uuid",
	"enum",
	"date",
	"time",
	"interval",
	"inet",
	"cidr",
	"xml",
	"money",
	"int4Range",
	"int8Range",
	"numRange",
	"tsRange",
	"tstzRange",
	"dateRange",
	"decimal",
]);

const COMPARABLE_FILTER_KINDS = new Set([
	"int",
	"serial",
	"real",
	"double",
	"timestamp",
	"bool",
	"bigint",
]);

function effectiveKind(col: ManifestColumn, manifest: Manifest): string {
	if (col.kind !== "fk") return col.kind;
	const referenced = findFkReferencedColumn(col, manifest);
	if (referenced && referenced.kind !== "fk") return referenced.kind;
	return "text";
}

function filterForColumn(
	col: ManifestColumn,
	manifest: Manifest,
	nonNullTs: string,
): string {
	const kind = effectiveKind(col, manifest);
	if (kind === "json" || kind === "jsonb") {
		return `JsonFilter<${nonNullTs}>`;
	}
	if (kind === "geometry" || kind === "geography" || kind === "point") {
		return "SpatialFilter";
	}
	if (STRING_FILTER_KINDS.has(kind)) {
		return `StringFilter<${nonNullTs}>`;
	}
	if (COMPARABLE_FILTER_KINDS.has(kind)) {
		return `ComparableFilter<${nonNullTs}>`;
	}
	return `EqualsFilter<${nonNullTs}>`;
}

function whereFieldType(
	col: ManifestColumn,
	manifest: Manifest,
	enums: EnumRegistry,
	accessor: string,
): string {
	const full = columnTsType(col, manifest, enums, accessor);
	const nonNull = columnNonNullTsType(col, manifest, enums, accessor);
	const filter = filterForColumn(col, manifest, nonNull);
	return `${full} | ${filter}`;
}

function emitWhereType(
	manifest: Manifest,
	table: ManifestTable,
	enums: EnumRegistry,
): string {
	const name = `${modelTypeName(table.accessor)}Where`;
	const lines: string[] = [];
	lines.push(`export interface ${name} {`);
	lines.push(`  AND?: ${name}[];`);
	lines.push(`  OR?: ${name}[];`);
	lines.push(`  NOT?: ${name};`);
	for (const col of table.columns) {
		lines.push(
			`  ${col.tsName}?: ${whereFieldType(col, manifest, enums, table.accessor)};`,
		);
	}
	for (const rel of effectiveRelations(manifest, table)) {
		const targetWhere = `${modelTypeName(rel.targetAccessor)}Where`;
		if (rel.cardinality === "many") {
			lines.push(
				`  ${rel.name}?: { some?: ${targetWhere}; every?: ${targetWhere}; none?: ${targetWhere} };`,
			);
		} else {
			lines.push(`  ${rel.name}?: ${targetWhere};`);
		}
	}
	lines.push(`}`);
	return lines.join("\n");
}

function emitWhereUniqueType(
	manifest: Manifest,
	table: ManifestTable,
	enums: EnumRegistry,
): string {
	const name = `${modelTypeName(table.accessor)}WhereUnique`;
	const candidates = uniqueKeyCandidates(table);
	if (candidates.length === 0) {
		return `export type ${name} = Record<string, unknown>;`;
	}
	const bySql = new Map(table.columns.map((c) => [c.sqlName, c]));
	const byTs = new Map(table.columns.map((c) => [c.tsName, c]));
	const members = candidates.map((keys) => {
		const fields = keys.map((tsName) => {
			const col =
				byTs.get(tsName) ??
				(bySql.get(tsName)
					? table.columns.find((c) => c.sqlName === tsName)
					: undefined);
			const ts = col
				? columnTsType(col, manifest, enums, table.accessor)
				: "string";
			return `${tsName}: UniqueEq<${ts}>`;
		});
		return `{ ${fields.join("; ")} }`;
	});
	return `export type ${name} = ${members.join(" | ")};`;
}

function emitOrderByType(table: ManifestTable): string {
	const name = `${modelTypeName(table.accessor)}OrderBy`;
	const fields = table.columns.map((c) => `  ${c.tsName}?: OrderDirection;`);
	return `export interface ${name} {\n${fields.join("\n")}\n}`;
}

function columnKeyUnion(table: ManifestTable): string {
	if (table.columns.length === 0) return "never";
	return table.columns.map((c) => JSON.stringify(c.tsName)).join(" | ");
}

function emitSelectOmitTypes(table: ManifestTable): string {
	const model = modelTypeName(table.accessor);
	const union = columnKeyUnion(table);
	const objectFields = table.columns
		.map((c) => `${c.tsName}?: true`)
		.join("; ");
	return [
		`export type ${model}Select = readonly (${union})[] | { ${objectFields} };`,
		`export type ${model}Omit = ${model}Select;`,
		`export type ${model}DistinctKey = ${union};`,
		`export type ${model}CountSelect = { _all?: true; ${objectFields} };`,
		`export type ${model}AggregateSelect = { ${objectFields} };`,
	].join("\n");
}

function emitConnectType(table: ManifestTable, manifest: Manifest): string {
	const model = modelTypeName(table.accessor);
	const pk = pkTsNames(table);
	if (pk.length === 0) {
		return `export type ${model}Connect = Record<string, unknown>;`;
	}
	const fields = pk.map((tsName) => {
		const col = table.columns.find((c) => c.tsName === tsName);
		const ts = col
			? columnNonNullTsType(col, manifest, null, table.accessor)
			: "string";
		return `${tsName}: ${ts}`;
	});
	return `export type ${model}Connect = { ${fields.join("; ")} };`;
}

function relationWriteField(
	manifest: Manifest,
	relation: {
		name: string;
		targetAccessor: string;
		cardinality: "one" | "many";
	},
): string {
	const targetModel = modelTypeName(relation.targetAccessor);
	const targetTable = manifest.tables[relation.targetAccessor];
	const uniqueName = targetTable
		? `${targetModel}WhereUnique`
		: "Record<string, unknown>";
	if (relation.cardinality === "many") {
		return `  ${relation.name}?: {
    connect?: ${targetModel}Connect | ${targetModel}Connect[];
    create?: Create${targetModel}Input | Create${targetModel}Input[];
    connectOrCreate?: { where: ${uniqueName}; create: Create${targetModel}Input } | { where: ${uniqueName}; create: Create${targetModel}Input }[];
    disconnect?: true | Record<string, unknown> | Record<string, unknown>[];
    delete?: true | Record<string, unknown> | Record<string, unknown>[];
    set?: Record<string, unknown>[];
  };`;
	}
	return `  ${relation.name}?: {
    connect?: ${targetModel}Connect;
    create?: Create${targetModel}Input;
    connectOrCreate?: { where: ${uniqueName}; create: Create${targetModel}Input };
    disconnect?: true;
    delete?: true | Record<string, unknown>;
  };`;
}

function emitCreateInputType(
	manifest: Manifest,
	table: ManifestTable,
	enums: EnumRegistry,
): string {
	const model = modelTypeName(table.accessor);
	const isJunction = isJunctionTable(manifest, table.accessor);
	const lines: string[] = [];
	lines.push(`export interface Create${model}Input {`);
	for (const col of table.columns) {
		if (isOmittedOnCreate(col, table, isJunction)) continue;
		const required = isCreateRequired(col, table, isJunction);
		const optional = required ? "" : "?";
		lines.push(
			`  ${col.tsName}${optional}: ${columnTsType(col, manifest, enums, table.accessor)};`,
		);
	}
	for (const rel of effectiveRelations(manifest, table)) {
		lines.push(relationWriteField(manifest, rel));
	}
	lines.push(`}`);
	return lines.join("\n");
}

function emitUpdateInputType(
	manifest: Manifest,
	table: ManifestTable,
	enums: EnumRegistry,
): string {
	const model = modelTypeName(table.accessor);
	const isJunction = isJunctionTable(manifest, table.accessor);
	const lines: string[] = [];
	lines.push(`export interface Update${model}Input {`);
	for (const col of table.columns) {
		if (isOmittedOnUpdate(col, table, isJunction)) continue;
		lines.push(
			`  ${col.tsName}?: ${updateScalarTsType(col, manifest, enums, table.accessor)};`,
		);
	}
	for (const rel of effectiveRelations(manifest, table)) {
		lines.push(relationWriteField(manifest, rel));
	}
	lines.push(`}`);
	return lines.join("\n");
}

function emitArgsTypes(table: ManifestTable): string {
	const model = modelTypeName(table.accessor);
	const withName = `${model}With`;
	return [
		`export interface FindMany${model}Args {`,
		`  where?: ${model}Where;`,
		`  orderBy?: ${model}OrderBy;`,
		`  take?: number;`,
		`  skip?: number;`,
		`  distinct?: ${model}Select;`,
		`  select?: ${model}Select;`,
		`  omit?: ${model}Omit;`,
		`  with?: ${withName};`,
		`  includeHidden?: boolean;`,
		`}`,
		`export interface FindUnique${model}Args {`,
		`  where: ${model}WhereUnique;`,
		`  select?: ${model}Select;`,
		`  omit?: ${model}Omit;`,
		`  with?: ${withName};`,
		`  includeHidden?: boolean;`,
		`}`,
		`export interface Create${model}Args {`,
		`  data: Create${model}Input;`,
		`  with?: ${withName};`,
		`  returnCreated?: boolean;`,
		`}`,
		`export interface CreateMany${model}Args {`,
		`  data: Create${model}Input[];`,
		`  skipDuplicates?: boolean;`,
		`}`,
		`export interface Upsert${model}Args {`,
		`  where: ${model}WhereUnique;`,
		`  create: Create${model}Input;`,
		`  update: Update${model}Input;`,
		`  with?: ${withName};`,
		`}`,
		`export interface FindOrCreate${model}Args {`,
		`  where: ${model}WhereUnique;`,
		`  create: Create${model}Input;`,
		`  select?: ${model}Select;`,
		`  omit?: ${model}Omit;`,
		`  with?: ${withName};`,
		`  includeHidden?: boolean;`,
		`}`,
		`export interface Update${model}Args {`,
		`  where: ${model}WhereUnique;`,
		`  data: Update${model}Input;`,
		`  with?: ${withName};`,
		`  returnUpdated?: boolean;`,
		`}`,
		`export interface UpdateMany${model}Args {`,
		`  where?: ${model}Where;`,
		`  data: Update${model}Input;`,
		`}`,
		`export interface Delete${model}Args {`,
		`  where: ${model}WhereUnique;`,
		`  with?: ${withName};`,
		`  returnDeleted?: boolean;`,
		`}`,
		`export interface DeleteMany${model}Args {`,
		`  where?: ${model}Where;`,
		`}`,
		`export interface Count${model}Args {`,
		`  where?: ${model}Where;`,
		`  distinct?: ${model}DistinctKey;`,
		`  select?: ${model}CountSelect;`,
		`}`,
		`export interface Exists${model}Args {`,
		`  where?: ${model}Where;`,
		`}`,
		`export interface Aggregate${model}Args {`,
		`  where?: ${model}Where;`,
		`  _count?: true | ${model}CountSelect;`,
		`  _avg?: ${model}AggregateSelect;`,
		`  _sum?: ${model}AggregateSelect;`,
		`  _min?: ${model}AggregateSelect;`,
		`  _max?: ${model}AggregateSelect;`,
		`}`,
		`export interface ${model}GroupByCountHaving {`,
		`  _all?: number | NumericHaving;`,
		...table.columns.map((c) => `  ${c.tsName}?: number | NumericHaving;`),
		`}`,
		`export interface ${model}NumericHavingFields {`,
		...table.columns.map((c) => `  ${c.tsName}?: number | NumericHaving;`),
		`}`,
		`export interface GroupBy${model}Having {`,
		`  _count?: number | NumericHaving | ${model}GroupByCountHaving;`,
		`  _avg?: ${model}NumericHavingFields;`,
		`  _sum?: ${model}NumericHavingFields;`,
		`  _min?: ${model}NumericHavingFields;`,
		`  _max?: ${model}NumericHavingFields;`,
		`}`,
		`export interface ${model}GroupByCountOrderBy {`,
		`  _all?: OrderDirection;`,
		...table.columns.map((c) => `  ${c.tsName}?: OrderDirection;`),
		`}`,
		`export interface ${model}FieldOrderBy {`,
		...table.columns.map((c) => `  ${c.tsName}?: OrderDirection;`),
		`}`,
		`export interface GroupBy${model}OrderBy extends ${model}OrderBy {`,
		`  _count?: OrderDirection | ${model}GroupByCountOrderBy;`,
		`  _avg?: ${model}FieldOrderBy;`,
		`  _sum?: ${model}FieldOrderBy;`,
		`  _min?: ${model}FieldOrderBy;`,
		`  _max?: ${model}FieldOrderBy;`,
		`}`,
		`export interface GroupBy${model}Args {`,
		`  by: ${model}Select;`,
		`  where?: ${model}Where;`,
		`  having?: GroupBy${model}Having;`,
		`  orderBy?: GroupBy${model}OrderBy;`,
		`  take?: number;`,
		`  skip?: number;`,
		`  _count?: true | ${model}CountSelect;`,
		`  _avg?: ${model}AggregateSelect;`,
		`  _sum?: ${model}AggregateSelect;`,
		`  _min?: ${model}AggregateSelect;`,
		`  _max?: ${model}AggregateSelect;`,
		`}`,
		`export interface Paginate${model}Args {`,
		`  where?: ${model}Where;`,
		`  orderBy: ${model}OrderBy;`,
		`  take: number;`,
		`  after?: Partial<${model}>;`,
		`  before?: Partial<${model}>;`,
		`  select?: ${model}Select;`,
		`  omit?: ${model}Omit;`,
		`  with?: ${withName};`,
		`  includeHidden?: boolean;`,
		`}`,
		`export type Count${model}Result<TArgs> = TArgs extends { select: infer S }`,
		`  ? S extends Record<string, unknown>`,
		`    ? { [K in keyof S as S[K] extends true ? K : never]: number }`,
		`    : number`,
		`  : number;`,
		`export type Aggregate${model}Result<TArgs> = (TArgs extends { _count: true }`,
		`  ? { _count: number }`,
		`  : TArgs extends { _count: infer C extends Record<string, true | undefined> }`,
		`    ? { _count: { [K in keyof C as C[K] extends true ? K : never]: number } }`,
		`    : Record<never, never>) & (TArgs extends { _avg: infer S extends Record<string, true> }`,
		`  ? { _avg: { [K in keyof S & string]: number | null } }`,
		`  : Record<never, never>) & (TArgs extends { _sum: infer S extends Record<string, true> }`,
		`  ? { _sum: { [K in keyof S & string]: number | null } }`,
		`  : Record<never, never>) & (TArgs extends { _min: infer S extends Record<string, true> }`,
		`  ? { _min: { [K in keyof S & string]: number | null } }`,
		`  : Record<never, never>) & (TArgs extends { _max: infer S extends Record<string, true> }`,
		`  ? { _max: { [K in keyof S & string]: number | null } }`,
		`  : Record<never, never>);`,
		`export type GroupBy${model}Result<TArgs> = Pick<${model}, QSelectKeys<TArgs extends { by: infer B } ? B : never> & keyof ${model}> & Aggregate${model}Result<TArgs>;`,
	].join("\n");
}

function visibleRowFor(table: ManifestTable, model: string): string {
	const hasHidden = table.columns.some((col) => col.hidden === true);
	return hasHidden ? `Omit<${model}, ${model}HiddenKeys>` : model;
}

function emitRepositoryType(table: ManifestTable): string {
	const model = modelTypeName(table.accessor);
	const withName = `${model}With`;
	const visibleRow = visibleRowFor(table, model);
	const pk = pkTsNames(table);
	const createMinimal =
		pk.length === 0
			? "Record<never, never>"
			: `Pick<${model}, ${pk.map((name) => JSON.stringify(name)).join(" | ")}>`;
	const narrowOmit = `"with" | "select" | "omit" | "includeHidden"`;
	const findCommon = (base: string) =>
		`Omit<${base}, ${narrowOmit}> & { includeHidden?: false }`;
	const findWith = (base: string) =>
		`Omit<${base}, ${narrowOmit}> & { with: W; select?: S; omit?: O; includeHidden?: IH }`;
	const findSelect = (base: string) =>
		`Omit<${base}, ${narrowOmit}> & { select: S; omit?: O; includeHidden?: IH }`;
	const findOmit = (base: string) =>
		`Omit<${base}, ${narrowOmit}> & { omit: O; includeHidden?: IH }`;
	const findHidden = (base: string) =>
		`Omit<${base}, ${narrowOmit}> & { includeHidden: true }`;
	const withGenerics = `const W extends ${withName}, const S extends ${model}Select | undefined = undefined, const O extends ${model}Omit | undefined = undefined, const IH extends boolean | undefined = undefined`;
	const selectGenerics = `const S extends ${model}Select, const O extends ${model}Omit | undefined = undefined, const IH extends boolean | undefined = undefined`;
	const omitGenerics = `const O extends ${model}Omit, const IH extends boolean | undefined = undefined`;
	return [
		`export interface ${model}Repository {`,
		`  findMany(args?: ${findCommon(`FindMany${model}Args`)}): Promise<${visibleRow}[]>;`,
		`  findMany<${withGenerics}>(args: ${findWith(`FindMany${model}Args`)}): Promise<${model}FindResult<W, S, O, IH>[]>;`,
		`  findMany<${selectGenerics}>(args: ${findSelect(`FindMany${model}Args`)}): Promise<${model}FindResult<undefined, S, O, IH>[]>;`,
		`  findMany<${omitGenerics}>(args: ${findOmit(`FindMany${model}Args`)}): Promise<${model}FindResult<undefined, undefined, O, IH>[]>;`,
		`  findMany(args: ${findHidden(`FindMany${model}Args`)}): Promise<${model}[]>;`,
		`  findFirst(args?: ${findCommon(`FindMany${model}Args`)}): Promise<${visibleRow} | null>;`,
		`  findFirst<${withGenerics}>(args: ${findWith(`FindMany${model}Args`)}): Promise<${model}FindResult<W, S, O, IH> | null>;`,
		`  findFirst<${selectGenerics}>(args: ${findSelect(`FindMany${model}Args`)}): Promise<${model}FindResult<undefined, S, O, IH> | null>;`,
		`  findFirst<${omitGenerics}>(args: ${findOmit(`FindMany${model}Args`)}): Promise<${model}FindResult<undefined, undefined, O, IH> | null>;`,
		`  findFirst(args: ${findHidden(`FindMany${model}Args`)}): Promise<${model} | null>;`,
		`  findUnique(args: ${findCommon(`FindUnique${model}Args`)}): Promise<${visibleRow} | null>;`,
		`  findUnique<${withGenerics}>(args: ${findWith(`FindUnique${model}Args`)}): Promise<${model}FindResult<W, S, O, IH> | null>;`,
		`  findUnique<${selectGenerics}>(args: ${findSelect(`FindUnique${model}Args`)}): Promise<${model}FindResult<undefined, S, O, IH> | null>;`,
		`  findUnique<${omitGenerics}>(args: ${findOmit(`FindUnique${model}Args`)}): Promise<${model}FindResult<undefined, undefined, O, IH> | null>;`,
		`  findUnique(args: ${findHidden(`FindUnique${model}Args`)}): Promise<${model} | null>;`,
		`  findById(id: string | Record<string, unknown>, args?: { includeHidden?: false }): Promise<${visibleRow} | null>;`,
		`  findById<${withGenerics}>(id: string | Record<string, unknown>, args: { with: W; select?: S; omit?: O; includeHidden?: IH }): Promise<${model}FindResult<W, S, O, IH> | null>;`,
		`  findById<${selectGenerics}>(id: string | Record<string, unknown>, args: { select: S; omit?: O; includeHidden?: IH }): Promise<${model}FindResult<undefined, S, O, IH> | null>;`,
		`  findById<${omitGenerics}>(id: string | Record<string, unknown>, args: { omit: O; includeHidden?: IH }): Promise<${model}FindResult<undefined, undefined, O, IH> | null>;`,
		`  findById(id: string | Record<string, unknown>, args: { includeHidden: true }): Promise<${model} | null>;`,
		`  create(args: Omit<Create${model}Args, "with" | "returnCreated">): Promise<${createMinimal}>;`,
		`  create<const W extends ${withName}>(args: Omit<Create${model}Args, "with" | "returnCreated"> & { with: W }): Promise<${model}CreateResult<W>>;`,
		`  create(args: Omit<Create${model}Args, "with" | "returnCreated"> & { returnCreated: true }): Promise<${model}>;`,
		`  createMany(args: CreateMany${model}Args): Promise<number>;`,
		`  createManyAndReturn(args: CreateMany${model}Args): Promise<${model}[]>;`,
		`  upsert(args: Omit<Upsert${model}Args, "with">): Promise<${model}>;`,
		`  upsert<const W extends ${withName}>(args: Omit<Upsert${model}Args, "with"> & { with: W }): Promise<${model}WithIncludes<W>>;`,
		`  findOrCreate(args: ${findCommon(`FindOrCreate${model}Args`)}): Promise<{ record: ${visibleRow}; created: boolean }>;`,
		`  findOrCreate<${withGenerics}>(args: ${findWith(`FindOrCreate${model}Args`)}): Promise<{ record: ${model}FindResult<W, S, O, IH>; created: boolean }>;`,
		`  findOrCreate<${selectGenerics}>(args: ${findSelect(`FindOrCreate${model}Args`)}): Promise<{ record: ${model}FindResult<undefined, S, O, IH>; created: boolean }>;`,
		`  findOrCreate<${omitGenerics}>(args: ${findOmit(`FindOrCreate${model}Args`)}): Promise<{ record: ${model}FindResult<undefined, undefined, O, IH>; created: boolean }>;`,
		`  findOrCreate(args: ${findHidden(`FindOrCreate${model}Args`)}): Promise<{ record: ${model}; created: boolean }>;`,
		`  update(args: Omit<Update${model}Args, "with" | "returnUpdated">): Promise<Record<never, never> | null>;`,
		`  update<const W extends ${withName}>(args: Omit<Update${model}Args, "with" | "returnUpdated"> & { with: W }): Promise<${model}MutationResult<W> | null>;`,
		`  update(args: Omit<Update${model}Args, "with" | "returnUpdated"> & { returnUpdated: true }): Promise<${model} | null>;`,
		`  updateMany(args: UpdateMany${model}Args): Promise<number>;`,
		`  updateManyAndReturn(args: UpdateMany${model}Args): Promise<${model}[]>;`,
		`  updateById(id: string | Record<string, unknown>, args: { data: Update${model}Input }): Promise<Record<never, never> | null>;`,
		`  updateById<const W extends ${withName}>(id: string | Record<string, unknown>, args: { data: Update${model}Input; with: W }): Promise<${model}MutationResult<W> | null>;`,
		`  updateById(id: string | Record<string, unknown>, args: { data: Update${model}Input; returnUpdated: true }): Promise<${model} | null>;`,
		`  delete(args: Omit<Delete${model}Args, "with" | "returnDeleted">): Promise<Record<never, never> | null>;`,
		`  delete<const W extends ${withName}>(args: Omit<Delete${model}Args, "with" | "returnDeleted"> & { with: W }): Promise<${model}MutationResult<W> | null>;`,
		`  delete(args: Omit<Delete${model}Args, "with" | "returnDeleted"> & { returnDeleted: true }): Promise<${model} | null>;`,
		`  deleteMany(args?: DeleteMany${model}Args): Promise<number>;`,
		`  deleteManyAndReturn(args?: DeleteMany${model}Args): Promise<${model}[]>;`,
		`  deleteById(id: string | Record<string, unknown>): Promise<Record<never, never> | null>;`,
		`  count(args?: Omit<Count${model}Args, "select">): Promise<number>;`,
		`  count<const TArgs extends Count${model}Args = Count${model}Args>(args?: TArgs): Promise<Count${model}Result<TArgs>>;`,
		`  exists(args?: Exists${model}Args): Promise<boolean>;`,
		`  aggregate<TArgs extends Aggregate${model}Args>(args: TArgs): Promise<Aggregate${model}Result<TArgs>>;`,
		`  groupBy<const TArgs extends GroupBy${model}Args>(args: TArgs): Promise<GroupBy${model}Result<TArgs>[]>;`,
		`  paginate(args: ${findCommon(`Paginate${model}Args`)}): Promise<PaginateResult<${visibleRow}, Partial<${model}> | null>>;`,
		`  paginate<const TOrderBy extends ${model}OrderBy, ${withGenerics}>(args: Omit<Paginate${model}Args, "orderBy" | ${narrowOmit}> & { orderBy: TOrderBy; with: W; select?: S; omit?: O; includeHidden?: IH }): Promise<PaginateResult<${model}FindResult<W, S, O, IH>, Partial<${model}> | null>>;`,
		`  paginate<const TOrderBy extends ${model}OrderBy, ${selectGenerics}>(args: Omit<Paginate${model}Args, "orderBy" | ${narrowOmit}> & { orderBy: TOrderBy; select: S; omit?: O; includeHidden?: IH }): Promise<PaginateResult<${model}FindResult<undefined, S, O, IH>, Partial<${model}> | null>>;`,
		`  paginate<const TOrderBy extends ${model}OrderBy, ${omitGenerics}>(args: Omit<Paginate${model}Args, "orderBy" | ${narrowOmit}> & { orderBy: TOrderBy; omit: O; includeHidden?: IH }): Promise<PaginateResult<${model}FindResult<undefined, undefined, O, IH>, Partial<${model}> | null>>;`,
		`  paginate(args: ${findHidden(`Paginate${model}Args`)}): Promise<PaginateResult<${model}, Partial<${model}> | null>>;`,
		`}`,
	].join("\n");
}

export function emitQueryTypesTs(manifest: Manifest): string {
	const tables = Object.values(manifest.tables).sort((a, b) =>
		a.accessor.localeCompare(b.accessor),
	);
	const enums = buildEnumRegistry(manifest);
	const hasPostgis = (manifest.extensions ?? []).includes("postgis");

	const modelNames = tables.map((t) => modelTypeName(t.accessor));
	const withNames = tables.map((t) => `${modelTypeName(t.accessor)}With`);
	const enumNames = [...enums.byName.keys()].sort();
	const resultNames = tables.flatMap((t) => {
		const m = modelTypeName(t.accessor);
		return [
			m,
			`${m}HiddenKeys`,
			`${m}FindResult`,
			`${m}CreateResult`,
			`${m}MutationResult`,
			`${m}WithIncludes`,
		];
	});

	const lines: string[] = [
		"// Auto-generated by neoorm generate — do not edit",
		`import type { ${[...new Set([...resultNames, ...enumNames])].join(", ")} } from "./models.js";`,
		`import type { ${[...new Set(withNames)].join(", ") || "NeoOrmIncludes"} } from "./includes.js";`,
		...(hasPostgis
			? [`import type { GeoJsonGeometry } from "./models.js";`]
			: []),
		"",
		'type OrderDirection = "asc" | "desc";',
		"",
		'type QueryMode = "default" | "insensitive";',
		"",
		"export interface StringFilter<T extends string = string> {",
		"  equals?: T;",
		"  contains?: T;",
		"  startsWith?: T;",
		"  endsWith?: T;",
		"  search?: T;",
		"  mode?: QueryMode;",
		"  in?: readonly T[];",
		"  notIn?: readonly T[];",
		"  isNull?: true;",
		"  isNotNull?: true;",
		"}",
		"",
		"export interface ComparableFilter<T> {",
		"  equals?: T;",
		"  gt?: T;",
		"  gte?: T;",
		"  lt?: T;",
		"  lte?: T;",
		"  in?: readonly T[];",
		"  notIn?: readonly T[];",
		"  isNull?: true;",
		"  isNotNull?: true;",
		"}",
		"",
		"export interface JsonFilter<T> {",
		"  equals?: T;",
		"  jsonContains?: Partial<T> | T;",
		"  hasKey?: string;",
		"  hasAnyKeys?: readonly string[];",
		"  hasAllKeys?: readonly string[];",
		"  path?: { segments: readonly string[]; equals?: unknown; jsonContains?: unknown };",
		"  isNull?: true;",
		"  isNotNull?: true;",
		"}",
		"",
		"export interface EqualsFilter<T> {",
		"  equals?: T;",
		"  isNull?: true;",
		"  isNotNull?: true;",
		"}",
		"",
		"export type UniqueEq<T> = T | { equals: T };",
		"",
		"export interface NumericHaving {",
		"  equals?: number;",
		"  gt?: number;",
		"  gte?: number;",
		"  lt?: number;",
		"  lte?: number;",
		"  in?: readonly number[];",
		"  notIn?: readonly number[];",
		"}",
		"",
		"export interface PaginateResult<TItem, TCursor> {",
		"  items: TItem[];",
		"  nextCursor: TCursor | null;",
		"  prevCursor: TCursor | null;",
		"  hasMore: boolean;",
		"  hasPrevious: boolean;",
		"}",
		"",
		"type QSelectKeys<S> = S extends readonly (infer K extends PropertyKey)[]",
		"  ? K",
		"  : S extends Record<string, unknown>",
		"    ? { [K in keyof S]: S[K] extends true ? K : never }[keyof S]",
		"    : never;",
		"",
	];

	if (hasPostgis) {
		lines.push(
			"export interface SpatialFilter {",
			"  equals?: GeoJsonGeometry;",
			"  intersects?: GeoJsonGeometry;",
			"  within?: GeoJsonGeometry;",
			"  dWithin?: { geometry: GeoJsonGeometry; distance: number };",
			"  isNull?: true;",
			"  isNotNull?: true;",
			"}",
			"",
		);
	}

	for (const table of tables) {
		lines.push(emitWhereType(manifest, table, enums));
		lines.push("");
		lines.push(emitWhereUniqueType(manifest, table, enums));
		lines.push("");
		lines.push(emitOrderByType(table));
		lines.push("");
		lines.push(emitSelectOmitTypes(table));
		lines.push("");
		lines.push(emitConnectType(table, manifest));
		lines.push("");
		lines.push(emitCreateInputType(manifest, table, enums));
		lines.push("");
		lines.push(emitUpdateInputType(manifest, table, enums));
		lines.push("");
		lines.push(emitArgsTypes(table));
		lines.push("");
	}

	for (const table of tables) {
		lines.push(emitRepositoryType(table));
		lines.push("");
		const model = modelTypeName(table.accessor);
		lines.push(`export type ${model}Include = ${model}With;`);
		lines.push("");
	}

	const repoEntries = tables
		.map((t) => `  ${t.accessor}: ${modelTypeName(t.accessor)}Repository;`)
		.join("\n");

	lines.push(`export type TransactionIsolationLevel =`);
	lines.push(`  | "ReadUncommitted"`);
	lines.push(`  | "ReadCommitted"`);
	lines.push(`  | "RepeatableRead"`);
	lines.push(`  | "Serializable";`);
	lines.push(``);
	lines.push(`export interface TransactionOptions {`);
	lines.push(`  isolationLevel?: TransactionIsolationLevel;`);
	lines.push(`  readOnly?: boolean;`);
	lines.push(`}`);
	lines.push(``);
	lines.push(
		`/** Transaction-scoped client (savepoints; no isolation/readOnly on nesting). */`,
	);
	lines.push(`export interface TransactionNeoOrmClient {`);
	lines.push(repoEntries);
	lines.push(`  sql<T = Record<string, unknown>>(`);
	lines.push(`    strings: TemplateStringsArray,`);
	lines.push(`    ...values: unknown[]`);
	lines.push(`  ): Promise<T[]>;`);
	lines.push(`  sqlId(name: string): {`);
	lines.push(`    readonly _kind: "fragment";`);
	lines.push(`    readonly text: string;`);
	lines.push(`    readonly params: readonly unknown[];`);
	lines.push(`  };`);
	lines.push(`  execute(query: {`);
	lines.push(`    text: string;`);
	lines.push(`    params: unknown[];`);
	lines.push(`  }): Promise<Record<string, unknown>[]>;`);
	lines.push(`  $connect(): Promise<void>;`);
	lines.push(`  $disconnect(): Promise<void>;`);
	lines.push(`  $transaction<T>(`);
	lines.push(`    fn: (tx: TransactionNeoOrmClient) => Promise<T>,`);
	lines.push(`  ): Promise<T>;`);
	lines.push(`  $transaction<T extends readonly unknown[]>(`);
	lines.push(
		`    steps: { [K in keyof T]: (tx: TransactionNeoOrmClient) => Promise<T[K]> } & readonly unknown[],`,
	);
	lines.push(`  ): Promise<T>;`);
	lines.push(`}`);
	lines.push(``);
	lines.push(
		`/** Generated flat client: one repository per table accessor plus database helpers. */`,
	);
	lines.push(`export interface NeoOrmClient {`);
	lines.push(repoEntries);
	lines.push(`  sql<T = Record<string, unknown>>(`);
	lines.push(`    strings: TemplateStringsArray,`);
	lines.push(`    ...values: unknown[]`);
	lines.push(`  ): Promise<T[]>;`);
	lines.push(`  sqlId(name: string): {`);
	lines.push(`    readonly _kind: "fragment";`);
	lines.push(`    readonly text: string;`);
	lines.push(`    readonly params: readonly unknown[];`);
	lines.push(`  };`);
	lines.push(`  execute(query: {`);
	lines.push(`    text: string;`);
	lines.push(`    params: unknown[];`);
	lines.push(`  }): Promise<Record<string, unknown>[]>;`);
	lines.push(`  $connect(): Promise<void>;`);
	lines.push(`  $disconnect(): Promise<void>;`);
	lines.push(`  $transaction<T>(`);
	lines.push(`    fn: (tx: TransactionNeoOrmClient) => Promise<T>,`);
	lines.push(`    options?: TransactionOptions,`);
	lines.push(`  ): Promise<T>;`);
	lines.push(`  $transaction<T extends readonly unknown[]>(`);
	lines.push(
		`    steps: { [K in keyof T]: (tx: TransactionNeoOrmClient) => Promise<T[K]> } & readonly unknown[],`,
	);
	lines.push(`    options?: TransactionOptions,`);
	lines.push(`  ): Promise<T>;`);
	lines.push(`}`);
	lines.push(``);

	void modelNames;

	return lines.join("\n");
}
