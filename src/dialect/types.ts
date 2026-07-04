export type ColumnKindMeta = "id" | "text" | "bool" | "int" | "timestamp" | "fk";

export type ManifestColumn = {
  tsName: string;
  sqlName: string;
  kind: ColumnKindMeta;
  nullable: boolean;
  unique: boolean;
  primary: boolean;
  defaultValue?: unknown;
  defaultNow: boolean;
  fkTarget?: string;
  fkAs?: string;
  fkInverse?: string;
  onDelete?: string;
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
};

export type ManifestTable = {
  accessor: string;
  sqlName: string;
  columns: ManifestColumn[];
  relations: ManifestRelation[];
  indexes: ManifestIndex[];
  primaryKey: readonly string[];
};

export type Manifest = {
  version: 1;
  tables: Record<string, ManifestTable>;
  manyToMany: ManifestManyToMany[];
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
  | "in";

export type OperatorMap = Record<
  WhereOperator,
  (sqlColumn: string, paramIndex: number) => string
>;

export type TableDiff = {
  create?: ManifestTable;
  addColumns?: ManifestColumn[];
  dropColumns?: string[];
};

export type Dialect = {
  readonly name: string;
  quoteIdentifier(name: string): string;
  columnType(col: ManifestColumn): string;
  emitCreateTable(table: ManifestTable): string;
  emitAlterTable(table: ManifestTable, diff: TableDiff): string[];
  whereOperators: OperatorMap;
  defaultNowExpression(): string;
};
