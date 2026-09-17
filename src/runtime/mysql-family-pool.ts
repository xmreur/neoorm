/**
 * Shared {@link NeoOrmPoolConfig} fields that apply when NeoORM creates a
 * MySQL or MariaDB pool. PostgreSQL-only keys (`ssl`, `statement_timeout`, …)
 * are ignored.
 */
export type MysqlFamilyPoolOptions = {
	max?: number | undefined;
	min?: number | undefined;
	idleTimeoutMillis?: number | null | undefined;
	connectionTimeoutMillis?: number | null | undefined;
	keepAlive?: boolean | undefined;
	keepAliveInitialDelayMillis?: number | undefined;
};

/** mysql2 / Drizzle-style default `connectionLimit`. */
export const MYSQL_FAMILY_POOL_MAX_DEFAULT = 10;

export type Mysql2PoolConfig = {
	uri: string;
	connectionLimit: number;
	waitForConnections: true;
	queueLimit: 0;
	enableKeepAlive: boolean;
	keepAliveInitialDelay: number;
	idleTimeout?: number;
	connectTimeout?: number;
};

export function toMysql2PoolConfig(
	url: string,
	pool?: MysqlFamilyPoolOptions,
): Mysql2PoolConfig {
	const config: Mysql2PoolConfig = {
		uri: url,
		connectionLimit: pool?.max ?? MYSQL_FAMILY_POOL_MAX_DEFAULT,
		waitForConnections: true,
		queueLimit: 0,
		enableKeepAlive: pool?.keepAlive ?? true,
		keepAliveInitialDelay: pool?.keepAliveInitialDelayMillis ?? 0,
	};
	if (pool?.idleTimeoutMillis != null) {
		config.idleTimeout = pool.idleTimeoutMillis;
	}
	if (pool?.connectionTimeoutMillis != null) {
		config.connectTimeout = pool.connectionTimeoutMillis;
	}
	return config;
}

export const MARIADB_PREPARE_CACHE_LENGTH = 256;

export type MariadbConnectorPoolConfig = {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	connectionLimit: number;
	pipelining: true;
	prepareCacheLength: number;
	minimumIdle?: number;
	idleTimeout?: number;
	acquireTimeout?: number;
	keepAliveDelay?: number;
};

export function parseMariadbUrl(url: string): {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
} {
	const parsed = new URL(url);
	return {
		host: parsed.hostname || "localhost",
		port: parsed.port ? Number(parsed.port) : 3306,
		user: decodeURIComponent(parsed.username),
		password: decodeURIComponent(parsed.password),
		database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
	};
}

export function toMariadbPoolConfig(
	url: string,
	pool?: MysqlFamilyPoolOptions,
): MariadbConnectorPoolConfig {
	const config: MariadbConnectorPoolConfig = {
		...parseMariadbUrl(url),
		connectionLimit: pool?.max ?? MYSQL_FAMILY_POOL_MAX_DEFAULT,
		pipelining: true,
		prepareCacheLength: MARIADB_PREPARE_CACHE_LENGTH,
	};
	if (pool?.min !== undefined) {
		config.minimumIdle = pool.min;
	}
	if (pool?.idleTimeoutMillis != null) {
		config.idleTimeout = Math.max(
			1,
			Math.round(pool.idleTimeoutMillis / 1000),
		);
	}
	if (pool?.connectionTimeoutMillis != null) {
		config.acquireTimeout = pool.connectionTimeoutMillis;
	}
	if (pool?.keepAlive !== false) {
		config.keepAliveDelay = pool?.keepAliveInitialDelayMillis ?? 0;
	}
	return config;
}
