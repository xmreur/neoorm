import {
	QueryErrorCode,
	type QueryErrorCodeValue,
	type SchemaErrorCodeValue,
} from "./error-codes.js";

export type QueryOperation =
	| "select"
	| "insert"
	| "update"
	| "delete"
	| "upsert"
	| "findOrCreate"
	| "raw";

/** Context attached to {@link NeoOrmQueryError}. */
export type QueryErrorContext = {
	operation: QueryOperation;
	code: QueryErrorCodeValue;
	tableAccessor?: string;
	tableSqlName?: string;
	columnTsName?: string;
	columnSqlName?: string;
	sql: string;
	pgCode?: string;
	constraint?: string;
	detail?: string;
	migrationHint?: string;
	phase?: "compile" | "runtime";
	suggestions?: string[];
};

/** Context attached to {@link NeoOrmSchemaError}. */
export type SchemaErrorContext = {
	code: SchemaErrorCodeValue;
	schemaPath?: string;
	tableAccessor?: string;
	tableSqlName?: string;
	manyToManyHint?: string;
	migrationName?: string;
	sqlPath?: string;
	statement?: string;
	detail?: string;
	suggestions?: string[];
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

function appendSuggestions(lines: string[], suggestions?: string[]): void {
	if (!suggestions || suggestions.length === 0) return;
	lines.push("");
	lines.push("  Suggestions:");
	for (const suggestion of suggestions) {
		lines.push(`  - ${suggestion}`);
	}
}

/** Format a query error context into a multi-line message. */
export function formatQueryError(context: QueryErrorContext): string {
	const target = operationTarget(context);
	const reason = context.detail ?? "database error";
	const lines: string[] = [];

	if (context.phase === "compile") {
		lines.push(`Query build failed on ${target}: ${reason}`);
	} else {
		const label = OPERATION_LABEL[context.operation];
		lines.push(`${label} on ${target} failed: ${reason}`);
	}

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

	appendSuggestions(lines, context.suggestions);

	return lines.join("\n");
}

/** Format a schema error context into a multi-line message. */
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

	appendSuggestions(lines, context.suggestions);

	return lines.join("\n").trimEnd();
}

/** Base class for all NeoOrm errors. */
export abstract class NeoOrmError extends Error {
	abstract readonly code: string;
	override readonly cause: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "NeoOrmError";
		this.cause = cause;
	}
}

/** Thrown when a query fails at compile time or at the database. */
export class NeoOrmQueryError extends NeoOrmError {
	readonly context: QueryErrorContext;
	readonly code: QueryErrorCodeValue;

	constructor(context: QueryErrorContext, cause?: unknown) {
		super(formatQueryError(context), cause);
		this.name = "NeoOrmQueryError";
		this.context = context;
		this.code = context.code;
	}
}

/** Thrown when a query fails at compile time (query builder mistakes). */
export class QueryCompileError extends NeoOrmQueryError {
	constructor(context: QueryErrorContext, cause?: unknown) {
		super({ ...context, phase: "compile" }, cause);
		this.name = "QueryCompileError";
	}
}

/** Thrown when a unique constraint is violated at the database. */
export class UniqueViolationError extends NeoOrmQueryError {
	constructor(context: QueryErrorContext, cause?: unknown) {
		super(
			{
				...context,
				code: QueryErrorCode.unique_violation,
				phase: "runtime",
			},
			cause,
		);
		this.name = "UniqueViolationError";
	}
}

/** Thrown when a foreign key constraint is violated at the database. */
export class ForeignKeyViolationError extends NeoOrmQueryError {
	constructor(context: QueryErrorContext, cause?: unknown) {
		super(
			{
				...context,
				code: QueryErrorCode.foreign_key_violation,
				phase: "runtime",
			},
			cause,
		);
		this.name = "ForeignKeyViolationError";
	}
}

/** Thrown when a not-null constraint is violated at the database. */
export class NotNullViolationError extends NeoOrmQueryError {
	constructor(context: QueryErrorContext, cause?: unknown) {
		super(
			{
				...context,
				code: QueryErrorCode.not_null_violation,
				phase: "runtime",
			},
			cause,
		);
		this.name = "NotNullViolationError";
	}
}

/** Thrown when a check constraint is violated at the database. */
export class CheckViolationError extends NeoOrmQueryError {
	constructor(context: QueryErrorContext, cause?: unknown) {
		super(
			{
				...context,
				code: QueryErrorCode.check_violation,
				phase: "runtime",
			},
			cause,
		);
		this.name = "CheckViolationError";
	}
}

/** Thrown when the database rejects a value due to invalid input/type. */
export class InvalidInputError extends NeoOrmQueryError {
	constructor(context: QueryErrorContext, cause?: unknown) {
		super(
			{
				...context,
				code: QueryErrorCode.invalid_input,
				phase: "runtime",
			},
			cause,
		);
		this.name = "InvalidInputError";
	}
}

/** Thrown when a table or column is missing (schema drift). */
export class SchemaDriftError extends NeoOrmQueryError {
	constructor(context: QueryErrorContext, cause?: unknown) {
		super({ ...context, phase: "runtime" }, cause);
		this.name = "SchemaDriftError";
	}
}

/** Pick the appropriate query error subclass for a context. */
export function createQueryError(
	context: QueryErrorContext,
	cause?: unknown,
): NeoOrmQueryError {
	if (context.phase === "compile") {
		return new QueryCompileError(context, cause);
	}

	switch (context.code) {
		case QueryErrorCode.unique_violation:
			return new UniqueViolationError(context, cause);
		case QueryErrorCode.foreign_key_violation:
			return new ForeignKeyViolationError(context, cause);
		case QueryErrorCode.not_null_violation:
			return new NotNullViolationError(context, cause);
		case QueryErrorCode.check_violation:
			return new CheckViolationError(context, cause);
		case QueryErrorCode.invalid_input:
			return new InvalidInputError(context, cause);
		case QueryErrorCode.relation_not_found:
		case QueryErrorCode.column_not_found:
			return new SchemaDriftError(context, cause);
		default:
			return new NeoOrmQueryError(context, cause);
	}
}

/** Thrown when schema compilation or migration fails. */
export class NeoOrmSchemaError extends NeoOrmError {
	readonly context: SchemaErrorContext;
	readonly code: SchemaErrorCodeValue;

	constructor(context: SchemaErrorContext, cause?: unknown) {
		super(formatSchemaError(context), cause);
		this.name = "NeoOrmSchemaError";
		this.context = context;
		this.code = context.code;
	}
}

/** Thrown when the database driver rejects a statement. */
export class NeoOrmDriverError extends NeoOrmError {
	readonly statement: string;
	readonly code = QueryErrorCode.driver_error;

	constructor(statement: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(detail, cause);
		this.name = "NeoOrmDriverError";
		this.statement = statement;
	}
}

export function isNeoOrmError(err: unknown): err is NeoOrmError {
	return err instanceof NeoOrmError;
}

export function isQueryError(err: unknown): err is NeoOrmQueryError {
	return err instanceof NeoOrmQueryError;
}

export function isSchemaError(err: unknown): err is NeoOrmSchemaError {
	return err instanceof NeoOrmSchemaError;
}

export function isQueryCompileError(err: unknown): err is QueryCompileError {
	return err instanceof QueryCompileError;
}

export function isUniqueViolation(err: unknown): err is UniqueViolationError {
	return err instanceof UniqueViolationError;
}

export function isForeignKeyViolation(
	err: unknown,
): err is ForeignKeyViolationError {
	return err instanceof ForeignKeyViolationError;
}

export function isNotNullViolation(err: unknown): err is NotNullViolationError {
	return err instanceof NotNullViolationError;
}

export function isCheckViolation(err: unknown): err is CheckViolationError {
	return err instanceof CheckViolationError;
}

export function isInvalidInput(err: unknown): err is InvalidInputError {
	return err instanceof InvalidInputError;
}

export function isSchemaDriftError(err: unknown): err is SchemaDriftError {
	return err instanceof SchemaDriftError;
}
