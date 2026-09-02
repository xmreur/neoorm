export type QueryOperation =
	| "select"
	| "insert"
	| "update"
	| "delete"
	| "upsert"
	| "findOrCreate"
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

export type SchemaErrorContext = {
	schemaPath?: string;
	tableAccessor?: string;
	tableSqlName?: string;
	manyToManyHint?: string;
	migrationName?: string;
	sqlPath?: string;
	statement?: string;
	detail?: string;
};

const OPERATION_LABEL: Record<QueryOperation, string> = {
	select: "Select",
	insert: "Insert",
	update: "Update",
	delete: "Delete",
	upsert: "Upsert",
	findOrCreate: "Find or create",
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
		if (context.tableAccessor)
			parts.push(`accessor: ${context.tableAccessor}`);
		if (context.tableSqlName) parts.push(`SQL: "${context.tableSqlName}"`);
		lines.push(`  Table: ${parts.join(", ")}`);
	}

	if (context.columnTsName || context.columnSqlName) {
		if (
			context.columnTsName &&
			context.columnSqlName &&
			context.columnTsName !== context.columnSqlName
		) {
			lines.push(
				`  Column: ${context.columnTsName} (SQL: "${context.columnSqlName}")`,
			);
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

export function formatSchemaError(context: SchemaErrorContext): string {
	const lines: string[] = [];

	if (context.schemaPath) {
		lines.push(`Schema error in ${context.schemaPath}`);
	} else {
		lines.push("Schema error");
	}
	lines.push("");

	if (context.tableAccessor || context.tableSqlName) {
		const parts: string[] = [];
		if (context.tableAccessor) {
			parts.push(context.tableAccessor);
		}
		if (context.tableSqlName) {
			parts.push(`SQL: "${context.tableSqlName}"`);
		}
		let tableLine = `  Table: ${parts.join(", ")}`;
		if (context.manyToManyHint) {
			tableLine += ` (${context.manyToManyHint})`;
		}
		lines.push(tableLine);
		lines.push("");
	}

	if (context.migrationName) {
		lines.push(`  Migration "${context.migrationName}" failed`);
		if (context.sqlPath) {
			lines.push(`  File: ${context.sqlPath}`);
		}
		lines.push("");
	}

	if (context.detail) {
		lines.push(`  ${context.detail}`);
		lines.push("");
	}

	if (context.statement) {
		lines.push("  SQL:");
		for (const line of context.statement.split("\n")) {
			lines.push(`  ${line}`);
		}
	}

	return lines.join("\n").trimEnd();
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

export class NeoOrmSchemaError extends Error {
	readonly context: SchemaErrorContext;
	override readonly cause: unknown;

	constructor(context: SchemaErrorContext, cause?: unknown) {
		super(formatSchemaError(context));
		this.name = "NeoOrmSchemaError";
		this.context = context;
		this.cause = cause;
	}
}

export class NeoOrmDriverError extends Error {
	readonly statement: string;
	override readonly cause: unknown;

	constructor(statement: string, cause: unknown) {
		const detail =
			cause instanceof Error ? cause.message : String(cause);
		super(detail);
		this.name = "NeoOrmDriverError";
		this.statement = statement;
		this.cause = cause;
	}
}
