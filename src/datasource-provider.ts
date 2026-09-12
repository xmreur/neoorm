export const DATABASE_PROVIDERS = ["postgresql", "postgres", "sqlite"] as const;

/** Config, manifest, and client all accept both Postgres spellings. */
export type DatabaseProvider = (typeof DATABASE_PROVIDERS)[number];

export function isDatabaseProvider(value: unknown): value is DatabaseProvider {
	return value === "postgresql" || value === "postgres" || value === "sqlite";
}

export function isSqliteProvider(provider: string | undefined): boolean {
	return provider === "sqlite";
}

export function isPostgresProvider(provider: string | undefined): boolean {
	return provider === "postgresql" || provider === "postgres";
}
