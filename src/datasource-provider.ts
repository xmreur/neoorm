export const DATABASE_PROVIDERS = [
	"postgresql",
	"postgres",
	"sqlite",
	"mysql",
	"mariadb",
] as const;

/** Config, manifest, and client all accept both Postgres spellings. */
export type DatabaseProvider = (typeof DATABASE_PROVIDERS)[number];

export type InitProvider = "postgresql" | "sqlite" | "mysql" | "mariadb";

export function isDatabaseProvider(value: unknown): value is DatabaseProvider {
	return (
		value === "postgresql" ||
		value === "postgres" ||
		value === "sqlite" ||
		value === "mysql" ||
		value === "mariadb"
	);
}

export function isSqliteProvider(provider: string | undefined): boolean {
	return provider === "sqlite";
}

export function isPostgresProvider(provider: string | undefined): boolean {
	return provider === "postgresql" || provider === "postgres";
}

export function isMysqlProvider(provider: string | undefined): boolean {
	return provider === "mysql";
}

export function isMariadbProvider(provider: string | undefined): boolean {
	return provider === "mariadb";
}

export function isMysqlFamilyProvider(provider: string | undefined): boolean {
	return isMysqlProvider(provider) || isMariadbProvider(provider);
}
