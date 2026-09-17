import type { Dialect } from "./types.js";

/** PostgreSQL / SQLite numbered bind (`$1`, `$2`, …). */
export function numberedPlaceholder(index: number): string {
	return `$${index}`;
}

/** mysql2 / MariaDB anonymous positional bind. */
export function positionalPlaceholder(_index?: number): string {
	return "?";
}

export function joinPlaceholders(
	dialect: Dialect,
	count: number,
	start = 1,
): string {
	if (count <= 0) return "";
	const parts = new Array<string>(count);
	for (let i = 0; i < count; i++) {
		parts[i] = dialect.placeholder(start + i);
	}
	return parts.join(", ");
}
