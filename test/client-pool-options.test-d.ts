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

const mysqlPoolOptions: NeoOrmClientOptions = {
	provider: "mysql",
	connectionString: "mysql://root@localhost:3306/neoorm",
	pool: {
		max: 10,
		idleTimeoutMillis: 10_000,
		keepAlive: true,
	},
};

void mysqlPoolOptions;

const mariadbPoolOptions: NeoOrmClientOptions = {
	provider: "mariadb",
	connectionString: "mariadb://root@localhost:3306/neoorm",
	pool: {
		max: 10,
		min: 1,
		idleTimeoutMillis: 10_000,
		keepAlive: true,
	},
};

void mariadbPoolOptions;

const _noConnectionStringInPool: NeoOrmPoolConfig = {
	// @ts-expect-error connection identity stays on NeoOrmClientOptions.connectionString
	connectionString: "postgresql://localhost/other",
};

void _noConnectionStringInPool;
