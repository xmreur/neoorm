export type QueryOperation =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "upsert"
  | "raw";

export type QueryErrorContext = {
  operation: QueryOperation;
  tableAccessor?: string;
  tableSqlName?: string;
  columnTsName?: string;
  columnSqlName?: string;
  sql: string;
  pgCode?: string;
  constraint?: string;
  detail?: string;
  migrationHint?: string;
};

const OPERATION_LABEL: Record<QueryOperation, string> = {
  select: "Select",
  insert: "Insert",
  update: "Update",
  delete: "Delete",
  upsert: "Upsert",
  raw: "Query",
};

function operationTarget(context: QueryErrorContext): string {
  if (context.tableAccessor) {
    return `"${context.tableAccessor}"`;
  }
  if (context.tableSqlName) {
    return `"${context.tableSqlName}"`;
  }
  return "query";
}

export function formatQueryError(context: QueryErrorContext): string {
  const label = OPERATION_LABEL[context.operation];
  const target = operationTarget(context);
  const reason = context.detail ?? "database error";
  const lines = [`${label} on ${target} failed: ${reason}`];

  if (context.tableAccessor || context.tableSqlName) {
    const parts: string[] = [];
    if (context.tableAccessor) parts.push(`accessor: ${context.tableAccessor}`);
    if (context.tableSqlName) parts.push(`SQL: "${context.tableSqlName}"`);
    lines.push(`  Table: ${parts.join(", ")}`);
  }

  if (context.columnTsName || context.columnSqlName) {
    if (
      context.columnTsName &&
      context.columnSqlName &&
      context.columnTsName !== context.columnSqlName
    ) {
      lines.push(`  Column: ${context.columnTsName} (SQL: "${context.columnSqlName}")`);
    } else if (context.columnTsName) {
      lines.push(`  Column: ${context.columnTsName}`);
    } else if (context.columnSqlName) {
      lines.push(`  Column: SQL: "${context.columnSqlName}"`);
    }
  }

  if (context.constraint) {
    lines.push(`  Constraint: ${context.constraint}`);
  }

  if (context.pgCode) {
    lines.push(`  PostgreSQL code: ${context.pgCode}`);
  }

  if (context.sql) {
    lines.push(`  SQL: ${context.sql}`);
  }

  if (context.migrationHint) {
    lines.push(`  Migration: ${context.migrationHint}`);
  }

  return lines.join("\n");
}

export class NeoOrmQueryError extends Error {
  readonly context: QueryErrorContext;
  override readonly cause: unknown;

  constructor(context: QueryErrorContext, cause?: unknown) {
    super(formatQueryError(context));
    this.name = "NeoOrmQueryError";
    this.context = context;
    this.cause = cause;
  }
}
