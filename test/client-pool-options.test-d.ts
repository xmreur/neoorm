import type { NeoOrmClientOptions, NeoOrmPoolConfig } from "neoorm";

const pool: NeoOrmPoolConfig = {
	max: 10,
	min: 1,
	idleTimeoutMillis: 10_000,
	connectionTimeoutMillis: 5_000,
	statement_timeout: 15_000,
	query_timeout: 15_000,
	lock_timeout: 5_000,
	application_name: "api",
	ssl: { rejectUnauthorized: true },
};

const options: NeoOrmClientOptions = {
	connectionString: "postgresql://localhost/neoorm",
	pool,
};

void options;

const _noConnectionStringInPool: NeoOrmPoolConfig = {
	// @ts-expect-error connection identity stays on NeoOrmClientOptions.connectionString
	connectionString: "postgresql://localhost/other",
};

void _noConnectionStringInPool;
