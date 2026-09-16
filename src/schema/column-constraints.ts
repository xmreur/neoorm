import {
	type DatabaseProvider,
	isMysqlFamilyProvider,
	isSqliteProvider,
} from "../datasource-provider.js";
import type { ManifestColumn } from "../dialect/types.js";
import { schemaError } from "../runtime/error-builders.js";
import { SchemaErrorCode } from "../runtime/error-codes.js";
import type { ColumnBuilder, ColumnMeta } from "./column.js";

/** Quote a SQL column identifier for CHECK expressions. */
export function quoteSqlColumn(
	sqlName: string,
	provider?: DatabaseProvider,
): string {
	if (isMysqlFamilyProvider(provider)) {
		return `\`${sqlName.replace(/`/g, "``")}\``;
	}
	return `"${sqlName.replace(/"/g, '""')}"`;
}

function lengthFunction(provider?: DatabaseProvider): "char_length" | "length" {
	return isSqliteProvider(provider) ? "length" : "char_length";
}

function formatCheckLiteral(value: number | bigint | string): string {
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`Invalid numeric constraint value: ${value}`);
		}
		return String(value);
	}
	if (!/^-?\d+(\.\d+)?$/.test(value)) {
		throw new Error(`Invalid decimal constraint value: ${value}`);
	}
	return value;
}

function andExpressions(left: string | undefined, right: string): string {
	return left ? `(${left}) AND (${right})` : right;
}

function assertPositiveInteger(
	name: string,
	value: number,
	tsName: string,
): void {
	if (!Number.isInteger(value) || value < 1) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			`Column "${tsName}": ${name} must be a positive integer (got ${value})`,
		);
	}
}

function assertNonNegativeInteger(
	name: string,
	value: number,
	tsName: string,
): void {
	if (!Number.isInteger(value) || value < 0) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			`Column "${tsName}": ${name} must be a non-negative integer (got ${value})`,
		);
	}
}

/** Compile structured constraint metadata into a single CHECK expression. */
export function compileColumnCheckConstraints(
	col: Pick<ManifestColumn, "sqlName" | "kind" | "tsName" | "typeOptions">,
	meta: Pick<
		ColumnMeta,
		| "checkExpression"
		| "checkMin"
		| "checkMax"
		| "checkPositive"
		| "checkMinLength"
		| "checkMaxLength"
		| "checkNotEmpty"
	>,
	provider?: DatabaseProvider,
): string | undefined {
	const quoted = quoteSqlColumn(col.sqlName, provider);
	const lengthFn = lengthFunction(provider);
	const parts: string[] = [];

	const maxLength = col.typeOptions?.maxLength as number | undefined;
	const minLength = meta.checkMinLength;
	const maxLengthCheck = meta.checkMaxLength;

	if (maxLength !== undefined) {
		assertPositiveInteger("maxLength", maxLength, col.tsName);
		if (isSqliteProvider(provider)) {
			parts.push(`${lengthFn}(${quoted}) <= ${maxLength}`);
		}
	}

	if (maxLengthCheck !== undefined) {
		assertPositiveInteger("maxLength", maxLengthCheck, col.tsName);
		parts.push(`${lengthFn}(${quoted}) <= ${maxLengthCheck}`);
	}

	if (minLength !== undefined) {
		assertNonNegativeInteger("minLength", minLength, col.tsName);
		parts.push(`${lengthFn}(${quoted}) >= ${minLength}`);
	}

	if (meta.checkNotEmpty) {
		parts.push(`${lengthFn}(${quoted}) > 0`);
	}

	const effectiveMax =
		maxLength ?? (col.kind === "citext" ? maxLengthCheck : undefined);
	if (
		minLength !== undefined &&
		effectiveMax !== undefined &&
		minLength > effectiveMax
	) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			`Column "${col.tsName}": minLength (${minLength}) cannot exceed maxLength (${effectiveMax})`,
		);
	}

	if (meta.checkPositive) {
		parts.push(`${quoted} > 0`);
	}

	if (meta.checkMin !== undefined) {
		parts.push(`${quoted} >= ${formatCheckLiteral(meta.checkMin)}`);
	}

	if (meta.checkMax !== undefined) {
		parts.push(`${quoted} <= ${formatCheckLiteral(meta.checkMax)}`);
	}

	if (meta.checkMin !== undefined && meta.checkMax !== undefined) {
		const minLit = formatCheckLiteral(meta.checkMin);
		const maxLit = formatCheckLiteral(meta.checkMax);
		if (Number(minLit) > Number(maxLit)) {
			throw schemaError(
				SchemaErrorCode.invalid_column,
				`Column "${col.tsName}": min (${meta.checkMin}) cannot exceed max (${meta.checkMax})`,
			);
		}
	}

	let compiled = parts.length > 0 ? parts.join(" AND ") : undefined;
	if (meta.checkExpression) {
		compiled = andExpressions(compiled, meta.checkExpression);
	}
	return compiled;
}

export type TextConstraintMethods = {
	maxLength(
		n: number,
	): ColumnBuilder<unknown, ColumnMeta> & TextConstraintMethods;
	minLength(
		n: number,
	): ColumnBuilder<unknown, ColumnMeta> & TextConstraintMethods;
	notEmpty(): ColumnBuilder<unknown, ColumnMeta> & TextConstraintMethods;
	/** Require an email address in generated validation schemas (not a SQL CHECK). */
	email(): ColumnBuilder<unknown, ColumnMeta> & TextConstraintMethods;
	/** Require a URL in generated validation schemas (not a SQL CHECK). */
	url(): ColumnBuilder<unknown, ColumnMeta> & TextConstraintMethods;
};

export type NumericConstraintMethods = {
	min(
		n: number | bigint | string,
	): ColumnBuilder<unknown, ColumnMeta> & NumericConstraintMethods;
	max(
		n: number | bigint | string,
	): ColumnBuilder<unknown, ColumnMeta> & NumericConstraintMethods;
	positive(): ColumnBuilder<unknown, ColumnMeta> & NumericConstraintMethods;
};

/** Text/citext length constraint helpers. */
export function createTextConstraintExtras<TValue, TMeta extends ColumnMeta>(
	meta: TMeta,
	rebuild: (
		nextMeta: TMeta,
	) => ColumnBuilder<TValue, TMeta> & TextConstraintMethods,
): TextConstraintMethods {
	return {
		/** Limit string length (`VARCHAR(n)` on Postgres; CHECK on SQLite). */
		maxLength(n: number) {
			if (meta.kind === "citext") {
				return rebuild({ ...meta, checkMaxLength: n } as TMeta);
			}
			return rebuild({
				...meta,
				typeOptions: { ...meta.typeOptions, maxLength: n },
			} as TMeta);
		},
		/** Require minimum string length via CHECK. */
		minLength(n: number) {
			return rebuild({ ...meta, checkMinLength: n } as TMeta);
		},
		/** Reject empty strings via CHECK (`char_length > 0`). */
		notEmpty() {
			return rebuild({ ...meta, checkNotEmpty: true } as TMeta);
		},
		/** Require an email address in generated validation schemas. */
		email() {
			return rebuild({ ...meta, checkEmail: true } as TMeta);
		},
		/** Require a URL in generated validation schemas. */
		url() {
			return rebuild({ ...meta, checkUrl: true } as TMeta);
		},
	};
}

/** Numeric min/max/positive constraint helpers. */
export function createNumericConstraintExtras<TValue, TMeta extends ColumnMeta>(
	meta: TMeta,
	rebuild: (
		nextMeta: TMeta,
	) => ColumnBuilder<TValue, TMeta> & NumericConstraintMethods,
): NumericConstraintMethods {
	return {
		/** Require values >= n via CHECK. */
		min(n: number | bigint | string) {
			return rebuild({ ...meta, checkMin: n } as TMeta);
		},
		/** Require values <= n via CHECK. */
		max(n: number | bigint | string) {
			return rebuild({ ...meta, checkMax: n } as TMeta);
		},
		/** Require values > 0 via CHECK. */
		positive() {
			return rebuild({ ...meta, checkPositive: true } as TMeta);
		},
	};
}
