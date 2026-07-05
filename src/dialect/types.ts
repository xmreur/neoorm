export type CoreColumnKind = "id" | "text" | "bool" | "int" | "timestamp" | "fk";
export type ColumnKindMeta = CoreColumnKind | (string & {});

export type ManifestColumn = {
  tsName: string;
  sqlName: string;
  kind: ColumnKindMeta;
  nullable: boolean;
  unique: boolean;
  primary: boolean;
  defaultValue?: unknown;
  defaultNow: boolean;
  updatedAt?: boolean;
  typeOptions?: Record<string, unknown>;
  fkTarget?: string;
  fkAs?: string;
  fkInverse?: string;
  onDelete?: string;
  fkConstraintName?: string;
  uniqueConstraintName?: string;
  storageSqlType?: string;
  checkExpression?: string;
  generated?: boolean;
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
  cardinality: "one" | "many";
  inverse: string;
  onDelete?: string;
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

export type ManifestIndex = {
  name: string;
  columns: readonly string[];
  unique: boolean;
  sqlName?: string;
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
};

export type Manifest = {
  version: 1;
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
  add?: { target: string; onDelete?: string; constraintName?: string };
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

export type Dialect = {
  readonly name: string;
  quoteIdentifier(name: string): string;
  columnType(col: ManifestColumn, manifest?: Manifest): string;
  resolveIndexSqlName(tableSqlName: string, index: ManifestIndex): string;
  emitCreateExtensions(extensions: readonly string[]): string[];
  emitCreateSchema(schema: string | undefined): string;
  emitCreateEnumTypes(enumTypes: Record<string, { values: readonly string[] }>): string[];
  emitCreateTable(table: ManifestTable, options?: CreateTableOptions): string;
  emitDropTable(table: ManifestTable): string;
  emitCreateIndex(table: ManifestTable, index: ManifestIndex): string;
  emitDropIndex(indexName: string): string;
  emitDropConstraint(tableSqlName: string, constraintName: string): string;
  emitAlterTable(table: ManifestTable, diff: TableDiff): string[];
  emitAlterColumn(table: ManifestTable, alter: ColumnAlter, manifest?: Manifest): string[];
  emitAddForeignKey(table: ManifestTable, col: ManifestColumn): string;
  whereOperators: OperatorMap;
  defaultNowExpression(): string;
};
