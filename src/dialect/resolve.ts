import type { DatabaseProvider } from "../datasource-provider.js";
import { isMysqlProvider, isSqliteProvider } from "../datasource-provider.js";
import { mysqlDialect } from "./mysql.js";
import { postgresDialect } from "./postgres.js";
import { sqliteDialect } from "./sqlite.js";
import type { Dialect, DialectName } from "./types.js";

export function dialectForProvider(
	provider: DatabaseProvider | undefined,
): Dialect {
	if (isSqliteProvider(provider)) return sqliteDialect;
	if (isMysqlProvider(provider)) return mysqlDialect;
	return postgresDialect;
}

export function isSqliteDialect(dialect: Dialect): boolean {
	return dialect.name === "sqlite";
}

export function isMysqlDialect(dialect: Dialect): boolean {
	return dialect.name === "mysql";
}

export function isPostgresDialect(dialect: Dialect): boolean {
	return dialect.name === "postgresql";
}

export function matchDialect<T>(
	dialect: Dialect,
	handlers: Record<DialectName, () => T>,
): T {
	switch (dialect.name) {
		case "postgresql":
			return handlers.postgresql();
		case "sqlite":
			return handlers.sqlite();
		case "mysql":
			return handlers.mysql();
		default: {
			const _never: never = dialect.name;
			return _never;
		}
	}
}

export function dialectDisplayName(name: DialectName): string {
	switch (name) {
		case "postgresql":
			return "PostgreSQL";
		case "sqlite":
			return "SQLite";
		case "mysql":
			return "MySQL";
		default: {
			const _never: never = name;
			return _never;
		}
	}
}
