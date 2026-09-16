/** PostgreSQL range kinds — no equivalent on SQLite or MySQL/MariaDB. */
export const RANGE_COLUMN_KINDS = new Set([
	"int4Range",
	"int8Range",
	"numRange",
	"tsRange",
	"tstzRange",
	"dateRange",
]);

/** PostgreSQL-only kinds rejected at schema compile on MySQL/MariaDB. */
export const MYSQL_UNSUPPORTED_COLUMN_KINDS = new Set([
	"interval",
	"inet",
	"cidr",
	...RANGE_COLUMN_KINDS,
]);

/** PostgreSQL-only kinds rejected at schema compile on SQLite. */
export const SQLITE_UNSUPPORTED_COLUMN_KINDS = new Set(RANGE_COLUMN_KINDS);

export function mysqlUnsupportedColumnKindMessage(
	kind: string,
	label: string,
): string {
	return `Column kind "${kind}" is not supported on ${label}`;
}

export function sqliteUnsupportedColumnKindMessage(kind: string): string {
	return `Column kind "${kind}" is not supported on SQLite`;
}
