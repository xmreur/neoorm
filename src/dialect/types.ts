import type { ValidationType } from "../codegen/validation/types.js";
import type { DatabaseProvider } from "../datasource-provider.js";

export type CoreColumnKind =
	| "id"
	| "text"
	| "bool"
	| "int"
	| "timestamp"
	| "fk";
export type ColumnKindMeta = CoreColumnKind | (string & {});

export type ManifestColumn = {
	tsName: string;
	sqlName: string;
	kind: ColumnKindMeta;
	nullable: boolean;
	unique: boolean;
	primary: boolean;
	index?: boolean;
	hidden?: boolean;
	defaultValue?: unknown;
	defaultNow: boolean;
	updatedAt?: boolean;
	typeOptions?: Record<string, unknown>;
	fkTarget?: string;
	fkAs?: string;
	fkInverse?: string;
	onDelete?: string;
	onUpdate?: string;
	deferrable?: string;
	fkConstraintName?: string;
	uniqueConstraintName?: string;
	storageSqlType?: string;
	checkExpression?: string;
	generated?: boolean;
	/** Structured CHECK helper values for validation emit. Ignored by migration diffs. */
	checkMin?: number | string;
	checkMax?: number | string;
	checkPositive?: boolean;
	checkMinLength?: number;
	checkMaxLength?: number;
	checkNotEmpty?: boolean;
	/** Client-side email format for validation emit. Ignored by migration diffs. */
	checkEmail?: boolean;
	/** Client-side URL format for validation emit. Ignored by migration diffs. */
	checkUrl?: boolean;
	/** JSON column validation shape for codegen. Ignored by migration diffs. */
	validation?: ValidationType;
};

export type ManifestEnumType = {
	values: readonly string[];
};

export type ManifestRelation = {
	name: string;
	targetTable: string;
	targetAccessor: string;
	fkColumn: string;
	fkSqlColumn: string;
	targetColumn: string;
	fkColumns?: readonly string[];
	fkSqlColumns?: readonly string[];
	targetColumns?: readonly string[];
	referencedSqlColumns?: readonly string[];
	cardinality: "one" | "many";
	inverse: string;
	onDelete?: string;
	onUpdate?: string;
	deferrable?: string;
};

export type ManifestForeignKey = {
	name: string;
	columns: readonly string[];
	targetTable: string;
	targetColumns: readonly string[];
	onDelete?: string;
	onUpdate?: string;
	deferrable?: string;
};

export type ManifestManyToMany = {
	leftTable: string;
	leftAccessor: string;
	rightTable: string;
	rightAccessor: string;
	throughTable: string;
	throughAccessor: string;
	leftFkColumn: string;
	rightFkColumn: string;
	leftRelation: string;
	rightRelation: string;
	as: string;
	inverse: string;
};

export type IndexMethod = "btree" | "hash" | "gin" | "gist" | "brin";

export type ManifestIndexKey = {
	sqlName?: string;
	expr?: string;
	opclass?: string;
};

export type ManifestIndex = {
	name: string;
	columns: readonly string[];
	unique: boolean;
	sqlName?: string;
	whereSql?: string;
	using?: IndexMethod;
	opclass?: string;
	keys?: readonly ManifestIndexKey[];
};

export type ManifestTable = {
	accessor: string;
	sqlName: string;
	schemaName?: string;
	columnNaming?: "snakeCase" | "camelCase";
	columns: ManifestColumn[];
	relations: ManifestRelation[];
	indexes: ManifestIndex[];
	primaryKey: readonly string[];
	foreignKeys?: ManifestForeignKey[];
};

export type Manifest = {
	version: 1;
	provider?: DatabaseProvider;
	url?: string;
	tables: Record<string, ManifestTable>;
	manyToMany: ManifestManyToMany[];
	extensions?: string[];
	enumMode?: "check" | "union" | "native";
	enumTypes?: Record<string, ManifestEnumType>;
};

export type CompiledQuery = {
	text: string;
	params: unknown[];
};

export type WhereOperator =
	| "equals"
	| "contains"
	| "startsWith"
	| "endsWith"
	| "search"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "in"
	| "notIn"
	| "isNull"
	| "isNotNull";

export type OperatorMap = Record<
	WhereOperator,
	(sqlColumn: string, paramIndex: number) => string
>;

export type ColumnAlter = {
	sqlName: string;
	setType?: ManifestColumn;
	fromSqlType?: string;
	setNullable?: boolean;
	setDefault?: ManifestColumn | null;
	setUnique?: boolean;
	dropUniqueConstraint?: string;
	setCheckExpression?: string | null;
};

export type FkChange = {
	column: string;
	columns?: readonly string[];
	add?: {
		target: string;
		targetColumns?: readonly string[];
		onDelete?: string;
		onUpdate?: string;
		deferrable?: string;
		constraintName?: string;
	};
	drop?: string;
};

export type TableDiff = {
	table: ManifestTable;
	create?: boolean;
	drop?: boolean;
	addColumns?: ManifestColumn[];
	dropColumns?: string[];
	renameColumns?: Array<{ from: string; to: string }>;
	alterColumns?: ColumnAlter[];
	addIndexes?: ManifestIndex[];
	dropIndexes?: string[];
	fkChanges?: FkChange[];
	manifest?: Manifest;
};

export type DestructiveChangeKind =
	| "drop_table"
	| "drop_column"
	| "alter_column_type"
	| "alter_column_type_manual"
	| "alter_enum_manual"
	| "drop_index"
	| "drop_fk"
	| "alter_primary_key";

export type DestructiveChange = {
	kind: DestructiveChangeKind;
	table: string;
	detail: string;
	sql: string;
};

export type ManifestDiff = {
	isInitial: boolean;
	sql: string[];
	destructive: DestructiveChange[];
};

export type CreateTableOptions = {
	inlineForeignKeys?: boolean;
	manifest?: Manifest;
};

export type DialectName = "postgresql" | "sqlite" | "mysql" | "mariadb";

export type Dialect = {
	readonly name: DialectName;
	readonly supportsReturning: boolean;
	/** Postgres-only: xmax is used by findOrCreate to distinguish insert vs conflict. */
	readonly supportsXmax: boolean;
	quoteIdentifier(name: string): string;
	tableRef(table: ManifestTable): string;
	columnType(col: ManifestColumn, manifest?: Manifest): string;
	resolveIndexSqlName(tableSqlName: string, index: ManifestIndex): string;
	emitCreateExtensions(extensions: readonly string[]): string[];
	emitCreateSchema(schema: string | undefined): string;
	emitCreateEnumTypes(
		enumTypes: Record<string, { values: readonly string[] }>,
	): string[];
	emitCreateTable(table: ManifestTable, options?: CreateTableOptions): string;
	emitDropTable(table: ManifestTable): string;
	emitCreateIndex(table: ManifestTable, index: ManifestIndex): string;
	emitDropIndex(indexName: string, tableSqlName?: string): string;
	emitDropConstraint(tableSqlName: string, constraintName: string): string;
	emitAlterTable(table: ManifestTable, diff: TableDiff): string[];
	emitAlterColumn(
		table: ManifestTable,
		alter: ColumnAlter,
		manifest?: Manifest,
	): string[];
	emitAddForeignKey(table: ManifestTable, col: ManifestColumn): string;
	emitAddTableForeignKey(
		table: ManifestTable,
		fk: ManifestForeignKey,
	): string;
	whereOperators: OperatorMap;
	ilike(sqlColumn: string, paramIndex: number): string;
	regex(sqlColumn: string, paramIndex: number, insensitive: boolean): string;
	/** Prefix between `INSERT` and `INTO`, e.g. `"IGNORE "` on MySQL. */
	insertIgnoreModifier(): string;
	onConflictDoNothing(): string;
	upsertConflictSql(
		conflictCols: string,
		setClauses: string,
		conflictWhere?: string,
	): string;
	excludedRef(quotedCol: string): string;
	defaultNowExpression(): string;
	emitCreateMigrationsTable(tableRef: string): string;
	castToInt(expr: string): string;
	castToNumeric(expr: string): string;
	rowToJsonObject(
		columns: readonly ManifestColumn[],
		refs: string[],
		aliasExpr: string,
	): string;
	jsonBuildObjectExpr(entries: string[]): string;
	jsonAggExpr(expr: string): string;
	jsonAggFilterExpr(expr: string, predicate: string): string;
};
