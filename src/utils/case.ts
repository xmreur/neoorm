import type { ColumnNaming } from "../schema/table.js";

export function toSnakeCase(str: string): string {
	return str
		.replace(/([A-Z])/g, "_$1")
		.replace(/^_/, "")
		.toLowerCase();
}

export function toCamelCase(str: string): string {
	return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Escape a value for embedding inside a double-quoted TypeScript string literal. */
export function escapeTsString(str: string): string {
	return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Coerce an arbitrary string into a valid TypeScript identifier. */
export function sanitizeTsIdentifier(str: string): string {
	const sanitized = str.replace(/[^A-Za-z0-9_$]/g, "_");
	if (/^[0-9]/.test(sanitized)) return `_${sanitized}`;
	return sanitized;
}

export function resolveSqlColumnName(
	tsName: string,
	strategy: ColumnNaming,
	mapName?: string,
): string {
	if (mapName) return mapName;

	switch (strategy) {
		case "camelCase":
			return tsName;
		case "snakeCase":
			return toSnakeCase(tsName);
		default: {
			const exhaustive: never = strategy;
			return exhaustive;
		}
	}
}

export function mapRowKeys<T extends Record<string, unknown>>(
	row: Record<string, unknown>,
): T {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		result[toCamelCase(key)] = value;
	}
	return result as T;
}

export function mapRowsKeys<T extends Record<string, unknown>>(
	rows: Record<string, unknown>[],
): T[] {
	return rows.map((row) => mapRowKeys<T>(row));
}
