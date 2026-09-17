import { Pool, type PoolConfig } from "pg";
import {
	type DatabaseProvider,
	isMariadbProvider,
	isMysqlProvider,
	isSqliteProvider,
} from "../datasource-provider.js";
import { mariadbDialect } from "../dialect/mariadb.js";
import { mysqlDialect } from "../dialect/mysql.js";
import {
	applySchemaToManifest,
	DEFAULT_PG_SCHEMA,
	postgresDialect,
	quoteQualifiedIdentifier,
	resolvePgSchemaName,
} from "../dialect/postgres.js";
import { sqliteDialect } from "../dialect/sqlite.js";
import type { Manifest } from "../dialect/types.js";
import { ensurePlugins } from "../plugins/ensure-plugins.js";
import type { TableDef } from "../schema/table.js";
import { qualifyTableIdentifiers } from "../sql/qualify-tables.js";
import { sqlFragment } from "../sql/template.js";
import type { SqliteClientOptions, SqliteDatabaseLike } from "./driver.js";
import { pgClient, sqliteClient } from "./driver.js";
import { queryError, schemaError } from "./error-builders.js";
import { QueryErrorCode, SchemaErrorCode } from "./error-codes.js";
import {
	compileQuery,
	createExecutor,
	createSqliteExecutor,
	type Executor,
	type ExecutorOptions,
	type QueryHooks,
} from "./executor.js";
import {
	createMariadbPoolFromUrl,
	MARIADB_PEER_MISSING,
	type MariadbPoolLike,
	mariadbClient,
} from "./mariadb-driver.js";
import {
	createMysqlPoolFromUrl,
	MYSQL2_PEER_MISSING,
	type MysqlPoolLike,
	mysqlClient,
} from "./mysql-driver.js";
import { aggregateRecords } from "./query/aggregate.js";
import type { OrderByInput } from "./query/compile.js";
import { countRecords, existsRecords, findUnique } from "./query/count.js";
import {
	createManyAndReturnRecords,
	createManyRecords,
	createRecord,
} from "./query/create.js";
import {
	deleteById,
	deleteManyAndReturnRecords,
	deleteManyRecords,
	deleteRecord,
} from "./query/delete.js";
import { type QueryRuntime, runQuery } from "./query/execute.js";
import type { WithInput } from "./query/find.js";
import { findById, findFirst, findMany } from "./query/find.js";
import { findOrCreateRecord } from "./query/find-or-create.js";
import { groupByRecords } from "./query/group-by.js";
import { paginateRecords } from "./query/paginate.js";
import { buildManifestIndex, requireTable } from "./query/table-index.js";
import {
	updateById,
	updateManyAndReturnRecords,
	updateManyRecords,
	updateRecord,
} from "./query/update.js";
import { upsertRecord } from "./query/upsert.js";
import {
	openSqliteDatabase,
	resolveSqliteDatabasePath,
} from "./sqlite-open.js";
import type {
	DefaultRowPayloadMap,
	DefaultWithMap,
	TransactionClient,
	TransactionOptions,
	TypedNeoOrmClient,
} from "./types.js";

/**
 * Options for {@link createNeoOrmClient}, {@link createNeoOrmClientFromPool},
 * and {@link createNeoOrmClientFromSqlite}.
 */
export type NeoOrmClientOptions = {
	/** PostgreSQL connection string. Falls back to `DATABASE_URL`. */
	connectionString?: string;
	/** Database provider. `"postgres"` is accepted as an alias of `"postgresql"`. Inferred from manifest when omitted. */
	provider?: DatabaseProvider;
	/** SQLite database handle (Bun or Node 22.5+). */
	db?: SqliteDatabaseLike;
	/** SQLite file path when `db` is not provided. */
	databasePath?: string;
	/** SQLite PRAGMAs applied when wrapping a connection. */
	sqlite?: SqliteClientOptions;
	/** Directory containing migration SQL files. */
	migrationsDir?: string;
	/** PostgreSQL schema name. @default "public" */
	schema?: string;
	/**
	 * When true, use PostgreSQL named prepared statements (best for repeated
	 * identical queries on a warm connection). Set to `false` for
	 * transaction-mode PgBouncer, which does not support named prepares.
	 * @default true
	 */
	preparedStatements?: boolean;
	/**
	 * Called before each data query (`query` / `queryOne` / `execute`).
	 * Transaction control statements (BEGIN/COMMIT/SAVEPOINT) are not included.
	 */
	beforeQuery?: QueryHooks["beforeQuery"];
	/**
	 * Called after each data query with duration, optional `rowCount`, and `error` on failure.
	 * Use this for slow-query logs.
	 */
	afterQuery?: QueryHooks["afterQuery"];
	/**
	 * Pool sizing and timeouts. Connection identity stays on
	 * {@link NeoOrmClientOptions.connectionString} (or `DATABASE_URL` /
	 * the manifest URL).
	 *
	 * Shared fields (`max`, `min`, `idleTimeoutMillis`,
	 * `connectionTimeoutMillis`, `keepAlive`, `keepAliveInitialDelayMillis`)
	 * apply to PostgreSQL, MySQL, and MariaDB. PostgreSQL-only keys (`ssl`,
	 * `statement_timeout`, …) are ignored for MySQL/MariaDB.
	 *
	 * Defaults: PostgreSQL `max` 20; MySQL/MariaDB `connectionLimit` 10 with
	 * TCP keep-alive. MySQL/MariaDB data queries use prepared `execute`.
	 */
	pool?: NeoOrmPoolConfig;
};

/**
 * Pool settings for {@link NeoOrmClientOptions.pool}.
 * Host/user/password/`connectionString` are omitted so the client URL remains
 * the single connection source.
 *
 * Shared keys map to `pg.Pool`, mysql2 (`connectionLimit`, `idleTimeout`,
 * `enableKeepAlive`), and the MariaDB connector (`connectionLimit`,
 * `idleTimeout` in seconds, `pipelining`). Extra PostgreSQL keys are ignored
 * on MySQL/MariaDB.
 */
export type NeoOrmPoolConfig = Pick<
	PoolConfig,
	| "max"
	| "min"
	| "idleTimeoutMillis"
	| "connectionTimeoutMillis"
	| "maxLifetimeSeconds"
	| "maxUses"
	| "allowExitOnIdle"
	| "ssl"
	| "sslnegotiation"
	| "enableChannelBinding"
	| "statement_timeout"
	| "query_timeout"
	| "lock_timeout"
	| "idle_in_transaction_session_timeout"
	| "application_name"
	| "fallback_application_name"
	| "keepAlive"
	| "keepAliveInitialDelayMillis"
>;

function pickExecutorOptions(
	options:
		| Pick<
				NeoOrmClientOptions,
				"preparedStatements" | "beforeQuery" | "afterQuery"
		  >
		| undefined,
): ExecutorOptions | undefined {
	if (!options) return undefined;
	const next: ExecutorOptions = {};
	if (options.preparedStatements !== undefined) {
		next.preparedStatements = options.preparedStatements;
	}
	if (options.beforeQuery) next.beforeQuery = options.beforeQuery;
	if (options.afterQuery) next.afterQuery = options.afterQuery;
	return Object.keys(next).length > 0 ? next : undefined;
}

function toPgPoolConfig(
	connectionString: string,
	pool?: NeoOrmPoolConfig,
): PoolConfig {
	return {
		connectionString,
		max: 20,
		...pool,
	};
}

/**
 * Untyped table repository. Prefer the generated typed client from `neoorm generate`.
 *
 * Shared args: `where`, `select`/`omit`, and `with` for relation includes.
 */
export type TableRepository = {
	findMany(args?: {
		where?: Record<string, unknown>;
		orderBy?: OrderByInput;
		take?: number;
		skip?: number;
		distinct?: readonly string[] | Record<string, boolean | undefined>;
		select?: readonly string[] | Record<string, boolean | undefined>;
		omit?: readonly string[] | Record<string, boolean | undefined>;
		with?: Record<string, WithInput>;
	}): Promise<Record<string, unknown>[]>;
	findFirst(args?: {
		where?: Record<string, unknown>;
		orderBy?: OrderByInput;
		skip?: number;
		distinct?: readonly string[] | Record<string, boolean | undefined>;
		select?: readonly string[] | Record<string, boolean | undefined>;
		omit?: readonly string[] | Record<string, boolean | undefined>;
		with?: Record<string, WithInput>;
	}): Promise<Record<string, unknown> | null>;
	findUnique(args: {
		where: Record<string, unknown>;
		select?: readonly string[] | Record<string, boolean | undefined>;
		omit?: readonly string[] | Record<string, boolean | undefined>;
		with?: Record<string, WithInput>;
		includeHidden?: boolean;
	}): Promise<Record<string, unknown> | null>;
	findById(
		id: string | Record<string, unknown>,
		args?: {
			select?: readonly string[] | Record<string, boolean | undefined>;
			omit?: readonly string[] | Record<string, boolean | undefined>;
			with?: Record<string, WithInput>;
		},
	): Promise<Record<string, unknown> | null>;
	create(args: {
		data: Record<string, unknown>;
		with?: Record<string, WithInput>;
		returnCreated?: boolean;
	}): Promise<Record<string, unknown>>;
	createMany(args: {
		data: Record<string, unknown>[];
		skipDuplicates?: boolean;
	}): Promise<number>;
	createManyAndReturn(args: {
		data: Record<string, unknown>[];
		skipDuplicates?: boolean;
	}): Promise<Record<string, unknown>[]>;
	upsert(args: {
		where: Record<string, unknown>;
		create: Record<string, unknown>;
		update: Record<string, unknown>;
		with?: Record<string, WithInput>;
	}): Promise<Record<string, unknown>>;
	findOrCreate(args: {
		where: Record<string, unknown>;
		create: Record<string, unknown>;
		select?: readonly string[] | Record<string, boolean | undefined>;
		omit?: readonly string[] | Record<string, boolean | undefined>;
		with?: Record<string, WithInput>;
		includeHidden?: boolean;
	}): Promise<{ record: Record<string, unknown>; created: boolean }>;
	update(args: {
		where: Record<string, unknown>;
		data: Record<string, unknown>;
		with?: Record<string, WithInput>;
		returnUpdated?: boolean;
	}): Promise<Record<string, unknown> | null>;
	updateMany(args: {
		where?: Record<string, unknown>;
		data: Record<string, unknown>;
	}): Promise<number>;
	updateManyAndReturn(args: {
		where?: Record<string, unknown>;
		data: Record<string, unknown>;
	}): Promise<Record<string, unknown>[]>;
	updateById(
		id: string | Record<string, unknown>,
		args: {
			data: Record<string, unknown>;
			with?: Record<string, WithInput>;
			returnUpdated?: boolean;
		},
	): Promise<Record<string, unknown> | null>;
	delete(args: {
		where: Record<string, unknown>;
		with?: Record<string, WithInput>;
		returnDeleted?: boolean;
	}): Promise<Record<string, unknown> | null>;
	deleteMany(args?: { where?: Record<string, unknown> }): Promise<number>;
	deleteManyAndReturn(args?: {
		where?: Record<string, unknown>;
	}): Promise<Record<string, unknown>[]>;
	count(args?: {
		where?: Record<string, unknown>;
		distinct?: string;
		select?: Record<string, boolean | undefined>;
	}): Promise<number | Record<string, number>>;
	exists(args?: { where?: Record<string, unknown> }): Promise<boolean>;
	aggregate(args: {
		where?: Record<string, unknown>;
		_count?: true | Record<string, true>;
		_avg?: Record<string, true>;
		_sum?: Record<string, true>;
		_min?: Record<string, true>;
		_max?: Record<string, true>;
	}): Promise<Record<string, unknown>>;
	groupBy(args: {
		by: readonly string[] | Record<string, boolean | undefined>;
		where?: Record<string, unknown>;
		having?: Record<string, unknown>;
		orderBy?: Record<string, string | Record<string, string>>;
		take?: number;
		skip?: number;
		_count?: true | Record<string, true>;
		_avg?: Record<string, true>;
		_sum?: Record<string, true>;
		_min?: Record<string, true>;
		_max?: Record<string, true>;
	}): Promise<Record<string, unknown>[]>;
	deleteById(
		id: string | Record<string, unknown>,
	): Promise<Record<string, unknown> | null>;
	paginate(args: {
		where?: Record<string, unknown>;
		orderBy: Record<string, string>;
		take: number;
		after?: Record<string, unknown>;
		before?: Record<string, unknown>;
		select?: readonly string[] | Record<string, boolean | undefined>;
		omit?: readonly string[] | Record<string, boolean | undefined>;
		with?: Record<string, WithInput>;
		includeHidden?: boolean;
	}): Promise<{
		items: Record<string, unknown>[];
		nextCursor: Record<string, unknown> | null;
		prevCursor: Record<string, unknown> | null;
		hasMore: boolean;
		hasPrevious: boolean;
	}>;
};

/** @deprecated Use TypedNeoOrmClient with createNeoOrmClient generic instead */
export interface NeoOrmClient {
	sql<T = Record<string, unknown>>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): Promise<T[]>;
	execute(query: {
		text: string;
		params: unknown[];
	}): Promise<Record<string, unknown>[]>;
	$connect(): Promise<void>;
	$disconnect(): Promise<void>;
	[tableAccessor: string]:
		| TableRepository
		| NeoOrmClient["sql"]
		| NeoOrmClient["execute"]
		| NeoOrmClient["$connect"]
		| NeoOrmClient["$disconnect"];
}

function createTableRepository(
	executor: Executor,
	runtime: QueryRuntime,
	accessor: string,
): TableRepository {
	const _table = requireTable(runtime.manifest, accessor, "select");

	return {
		findMany: (args) => findMany(executor, runtime, accessor, args),
		findFirst: (args) => findFirst(executor, runtime, accessor, args),
		findUnique: (args) => findUnique(executor, runtime, accessor, args),
		findById: (id, args) => findById(executor, runtime, accessor, id, args),
		create: (args) => createRecord(executor, runtime, accessor, args),
		createMany: (args) =>
			createManyRecords(executor, runtime, accessor, args),
		createManyAndReturn: (args) =>
			createManyAndReturnRecords(executor, runtime, accessor, args),
		upsert: (args) => upsertRecord(executor, runtime, accessor, args),
		findOrCreate: (args) =>
			findOrCreateRecord(executor, runtime, accessor, args),
		update: (args) => updateRecord(executor, runtime, accessor, args),
		updateMany: (args) =>
			updateManyRecords(executor, runtime, accessor, args),
		updateManyAndReturn: (args) =>
			updateManyAndReturnRecords(executor, runtime, accessor, args),
		updateById: (id, args) =>
			updateById(executor, runtime, accessor, id, args),
		delete: (args) => deleteRecord(executor, runtime, accessor, args),
		deleteMany: (args) =>
			deleteManyRecords(executor, runtime, accessor, args),
		deleteManyAndReturn: (args) =>
			deleteManyAndReturnRecords(executor, runtime, accessor, args),
		count: (args) => countRecords(executor, runtime, accessor, args),
		exists: (args) => existsRecords(executor, runtime, accessor, args),
		aggregate: (args) =>
			aggregateRecords(executor, runtime, accessor, args),
		groupBy: (args) => groupByRecords(executor, runtime, accessor, args),
		deleteById: (id) => deleteById(executor, runtime, accessor, id),
		paginate: (args) => paginateRecords(executor, runtime, accessor, args),
	};
}

function buildClient<
	TTables extends Record<string, TableDef>,
	TIncludes extends Record<
		keyof TTables & string,
		unknown
	> = DefaultWithMap<TTables>,
	TRowPayloads extends Record<
		keyof TTables & string,
		Record<string, unknown>
	> = DefaultRowPayloadMap<TTables>,
>(
	executor: Executor,
	runtime: QueryRuntime,
	disconnect: () => Promise<void>,
	options?: { transactional?: boolean },
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
	const transactional = options?.transactional ?? false;
	const tableSqlNames = new Set(
		Object.values(runtime.manifest.tables).map((table) => table.sqlName),
	);
	const tenantSchema =
		runtime.schema &&
		runtime.schema !== DEFAULT_PG_SCHEMA &&
		(runtime.dialect === undefined || runtime.dialect === postgresDialect)
			? runtime.schema
			: undefined;

	const rewriteRawSql = (text: string): string => {
		if (!tenantSchema) return text;
		return qualifyTableIdentifiers(text, {
			tableNames: tableSqlNames,
			qualify: (sqlName) =>
				quoteQualifiedIdentifier(tenantSchema, sqlName),
		});
	};

	const client = {
		sql<T = Record<string, unknown>>(
			strings: TemplateStringsArray,
			...values: unknown[]
		): Promise<T[]> {
			const { text, params } = compileQuery(strings, values);
			return runQuery<T>(
				executor,
				runtime,
				{ operation: "raw" },
				rewriteRawSql(text),
				params,
			);
		},

		sqlId(name: string) {
			const dialect = runtime.dialect ?? postgresDialect;
			if (tenantSchema && tableSqlNames.has(name)) {
				return sqlFragment(
					quoteQualifiedIdentifier(tenantSchema, name),
					[],
				);
			}
			return sqlFragment(dialect.quoteIdentifier(name), []);
		},

		execute(query: { text: string; params: unknown[] }) {
			return runQuery(
				executor,
				runtime,
				{ operation: "raw" },
				rewriteRawSql(query.text),
				query.params,
			);
		},

		$connect: transactional
			? async () => {
					throw queryError(
						QueryErrorCode.invalid_args,
						"Cannot connect inside a transaction",
						{ operation: "raw", phase: "runtime" },
					);
				}
			: async () => {
					if (!runtime.driver) return;
					try {
						await runtime.driver.query("SELECT 1");
					} catch (err) {
						throw queryError(
							QueryErrorCode.connection_error,
							"Failed to connect to the database",
							{
								operation: "raw",
								phase: "runtime",
								sql: "SELECT 1",
							},
							undefined,
							err,
						);
					}
				},

		$disconnect: transactional
			? async () => {
					throw queryError(
						QueryErrorCode.invalid_args,
						"Cannot disconnect inside a transaction",
						{ operation: "raw", phase: "runtime" },
					);
				}
			: disconnect,

		$transaction<T>(
			fnOrSteps:
				| ((
						tx: TransactionClient<TTables, TIncludes, TRowPayloads>,
				  ) => Promise<T>)
				| ReadonlyArray<
						(
							tx: TransactionClient<
								TTables,
								TIncludes,
								TRowPayloads
							>,
						) => Promise<unknown>
				  >,
			txOptions?: TransactionOptions,
		): Promise<T> {
			const runWithExecutor = async (txExecutor: Executor) => {
				const tx = transactional
					? (client as TypedNeoOrmClient<
							TTables,
							TIncludes,
							TRowPayloads
						>)
					: buildClient<TTables, TIncludes, TRowPayloads>(
							txExecutor,
							runtime,
							disconnect,
							{ transactional: true },
						);

				if (typeof fnOrSteps === "function") {
					return fnOrSteps(tx);
				}

				const results: unknown[] = [];
				for (const step of fnOrSteps) {
					results.push(await step(tx));
				}
				return results as T;
			};

			return executor.transaction(runWithExecutor, txOptions);
		},
	} as TypedNeoOrmClient<TTables, TIncludes, TRowPayloads>;

	for (const accessor of Object.keys(runtime.manifest.tables)) {
		(client as Record<string, TableRepository>)[accessor] =
			createTableRepository(executor, runtime, accessor);
	}

	return client;
}

/**
 * Create a typed NeoOrm client from a compiled manifest.
 *
 * `$disconnect()` ends the `pg` pool this function creates. Pass an existing
 * pool to {@link createNeoOrmClientFromPool} if other code must keep using it.
 *
 * @param manifest - Manifest emitted by `neoorm generate`.
 * @param connectionStringOrOptions - PostgreSQL URL or connection options.
 */
export function createNeoOrmClient<
	TTables extends Record<string, TableDef>,
	TIncludes extends Record<
		keyof TTables & string,
		unknown
	> = DefaultWithMap<TTables>,
	TRowPayloads extends Record<
		keyof TTables & string,
		Record<string, unknown>
	> = DefaultRowPayloadMap<TTables>,
>(
	manifest: Manifest,
	connectionStringOrOptions?: string | NeoOrmClientOptions,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
	ensurePlugins(manifest);

	const options =
		typeof connectionStringOrOptions === "string"
			? { connectionString: connectionStringOrOptions }
			: (connectionStringOrOptions ?? {});

	if (
		isSqliteProvider(options.provider) ||
		isSqliteProvider(manifest.provider) ||
		options.db !== undefined ||
		options.databasePath !== undefined
	) {
		const sqliteOptions: Pick<
			NeoOrmClientOptions,
			"migrationsDir" | "sqlite" | "beforeQuery" | "afterQuery"
		> = {
			...(options.migrationsDir !== undefined
				? { migrationsDir: options.migrationsDir }
				: {}),
			...(options.sqlite !== undefined ? { sqlite: options.sqlite } : {}),
			...(options.beforeQuery !== undefined
				? { beforeQuery: options.beforeQuery }
				: {}),
			...(options.afterQuery !== undefined
				? { afterQuery: options.afterQuery }
				: {}),
		};
		if (options.db !== undefined) {
			return createNeoOrmClientFromSqlite(
				manifest,
				options.db,
				sqliteOptions,
			);
		}
		const db = openSqliteDatabase(
			resolveSqliteDatabasePath(options.databasePath, manifest.url),
		);
		return createNeoOrmSqliteClient(manifest, db, sqliteOptions, true);
	}

	if (
		isMysqlProvider(options.provider) ||
		isMysqlProvider(manifest.provider)
	) {
		const url =
			options.connectionString ??
			process.env.MYSQL_URL ??
			process.env.DATABASE_URL ??
			manifest.url;
		if (!url) {
			throw schemaError(
				SchemaErrorCode.invalid_config,
				"MYSQL_URL or DATABASE_URL is required for MySQL",
			);
		}
		let pool: MysqlPoolLike;
		try {
			pool = createMysqlPoolFromUrl(url, options.pool);
		} catch (err) {
			if (err instanceof Error && err.message === MYSQL2_PEER_MISSING) {
				throw schemaError(
					SchemaErrorCode.invalid_config,
					MYSQL2_PEER_MISSING,
				);
			}
			throw err;
		}
		return createNeoOrmMysqlClient(manifest, pool, options, true);
	}

	if (
		isMariadbProvider(options.provider) ||
		isMariadbProvider(manifest.provider)
	) {
		const url =
			options.connectionString ??
			process.env.MARIADB_URL ??
			process.env.DATABASE_URL ??
			manifest.url;
		if (!url) {
			throw schemaError(
				SchemaErrorCode.invalid_config,
				"MARIADB_URL or DATABASE_URL is required for MariaDB",
			);
		}
		let pool: MariadbPoolLike;
		try {
			pool = createMariadbPoolFromUrl(url, options.pool);
		} catch (err) {
			if (err instanceof Error && err.message === MARIADB_PEER_MISSING) {
				throw schemaError(
					SchemaErrorCode.invalid_config,
					MARIADB_PEER_MISSING,
				);
			}
			throw err;
		}
		return createNeoOrmMariadbClient(manifest, pool, options, true);
	}

	const url =
		options.connectionString ?? process.env.DATABASE_URL ?? manifest.url;
	if (!url) {
		throw schemaError(
			SchemaErrorCode.invalid_config,
			"DATABASE_URL is required",
		);
	}

	const pool = new Pool(toPgPoolConfig(url, options.pool));
	const schema = resolvePgSchemaName(options.schema);
	const executor = createExecutor(pool, pickExecutorOptions(options));
	const appliedManifest = applySchemaToManifest(manifest, schema);
	const runtime: QueryRuntime = {
		manifest: appliedManifest,
		tableIndex: buildManifestIndex(appliedManifest, postgresDialect),
		schema,
		driver: pgClient(pool),
		dialect: postgresDialect,
		...(options.migrationsDir !== undefined
			? { migrationsDir: options.migrationsDir }
			: {}),
	};

	return buildClient<TTables, TIncludes, TRowPayloads>(
		executor,
		runtime,
		async () => {
			await pool.end();
		},
	);
}

async function noopDisconnect(): Promise<void> {
	return;
}

/**
 * Create a typed NeoOrm client from an existing `pg` connection pool.
 *
 * `$disconnect()` does not call `pool.end()`. The caller owns the pool and
 * must close it.
 *
 * @param manifest - Manifest emitted by `neoorm generate`.
 * @param pool - Node `pg` Pool instance.
 */
export function createNeoOrmClientFromPool<
	TTables extends Record<string, TableDef>,
	TIncludes extends Record<
		keyof TTables & string,
		unknown
	> = DefaultWithMap<TTables>,
	TRowPayloads extends Record<
		keyof TTables & string,
		Record<string, unknown>
	> = DefaultRowPayloadMap<TTables>,
>(
	manifest: Manifest,
	pool: Pool,
	options?: Pick<
		NeoOrmClientOptions,
		| "migrationsDir"
		| "schema"
		| "preparedStatements"
		| "beforeQuery"
		| "afterQuery"
	>,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
	ensurePlugins(manifest);

	const schema = resolvePgSchemaName(options?.schema);
	const executor = createExecutor(pool, pickExecutorOptions(options));
	const appliedManifest = applySchemaToManifest(manifest, schema);
	const runtime: QueryRuntime = {
		manifest: appliedManifest,
		tableIndex: buildManifestIndex(appliedManifest, postgresDialect),
		schema,
		driver: pgClient(pool),
		dialect: postgresDialect,
		...(options?.migrationsDir !== undefined
			? { migrationsDir: options.migrationsDir }
			: {}),
	};

	return buildClient<TTables, TIncludes, TRowPayloads>(
		executor,
		runtime,
		noopDisconnect,
	);
}

/**
 * Create a typed NeoOrm client from an existing SQLite database handle.
 *
 * `$disconnect()` does not call `db.close()`. The caller owns the handle and
 * must close it.
 *
 * @param manifest - Manifest emitted by `neoorm generate`.
 * @param db - `node:sqlite` / `bun:sqlite` database, or any `SqliteDatabaseLike`.
 */
export function createNeoOrmClientFromSqlite<
	TTables extends Record<string, TableDef>,
	TIncludes extends Record<
		keyof TTables & string,
		unknown
	> = DefaultWithMap<TTables>,
	TRowPayloads extends Record<
		keyof TTables & string,
		Record<string, unknown>
	> = DefaultRowPayloadMap<TTables>,
>(
	manifest: Manifest,
	db: SqliteDatabaseLike,
	options?: Pick<
		NeoOrmClientOptions,
		"migrationsDir" | "sqlite" | "beforeQuery" | "afterQuery"
	>,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
	return createNeoOrmSqliteClient(manifest, db, options, false);
}

/**
 * Create a typed NeoOrm client from an existing mysql2 promise pool.
 *
 * `$disconnect()` does not call `pool.end()`. The caller owns the pool.
 */
export function createNeoOrmClientFromMysql<
	TTables extends Record<string, TableDef>,
	TIncludes extends Record<
		keyof TTables & string,
		unknown
	> = DefaultWithMap<TTables>,
	TRowPayloads extends Record<
		keyof TTables & string,
		Record<string, unknown>
	> = DefaultRowPayloadMap<TTables>,
>(
	manifest: Manifest,
	pool: MysqlPoolLike,
	options?: Pick<
		NeoOrmClientOptions,
		"migrationsDir" | "beforeQuery" | "afterQuery"
	>,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
	return createNeoOrmMysqlClient(manifest, pool, options, false);
}

/**
 * Create a typed NeoOrm client from an existing `mariadb` pool.
 *
 * `$disconnect()` does not call `pool.end()`. The caller owns the pool.
 */
export function createNeoOrmClientFromMariadb<
	TTables extends Record<string, TableDef>,
	TIncludes extends Record<
		keyof TTables & string,
		unknown
	> = DefaultWithMap<TTables>,
	TRowPayloads extends Record<
		keyof TTables & string,
		Record<string, unknown>
	> = DefaultRowPayloadMap<TTables>,
>(
	manifest: Manifest,
	pool: MariadbPoolLike,
	options?: Pick<
		NeoOrmClientOptions,
		"migrationsDir" | "beforeQuery" | "afterQuery"
	>,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
	return createNeoOrmMariadbClient(manifest, pool, options, false);
}

function createNeoOrmMysqlClient<
	TTables extends Record<string, TableDef>,
	TIncludes extends Record<
		keyof TTables & string,
		unknown
	> = DefaultWithMap<TTables>,
	TRowPayloads extends Record<
		keyof TTables & string,
		Record<string, unknown>
	> = DefaultRowPayloadMap<TTables>,
>(
	manifest: Manifest,
	pool: MysqlPoolLike,
	options:
		| Pick<
				NeoOrmClientOptions,
				"migrationsDir" | "beforeQuery" | "afterQuery"
		  >
		| undefined,
	ownsPool: boolean,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
	ensurePlugins(manifest);

	const driver = mysqlClient(pool, { ownsPool });
	const appliedManifest = applySchemaToManifest(manifest, undefined);
	const runtime: QueryRuntime = {
		manifest: appliedManifest,
		tableIndex: buildManifestIndex(appliedManifest, mysqlDialect),
		driver,
		dialect: mysqlDialect,
		...(options?.migrationsDir !== undefined
			? { migrationsDir: options.migrationsDir }
			: {}),
	};

	const executor = createSqliteExecutor(driver, pickExecutorOptions(options));
	return buildClient<TTables, TIncludes, TRowPayloads>(
		executor,
		runtime,
		ownsPool
			? async () => {
					await driver.close();
				}
			: noopDisconnect,
	);
}

function createNeoOrmMariadbClient<
	TTables extends Record<string, TableDef>,
	TIncludes extends Record<
		keyof TTables & string,
		unknown
	> = DefaultWithMap<TTables>,
	TRowPayloads extends Record<
		keyof TTables & string,
		Record<string, unknown>
	> = DefaultRowPayloadMap<TTables>,
>(
	manifest: Manifest,
	pool: MariadbPoolLike,
	options:
		| Pick<
				NeoOrmClientOptions,
				"migrationsDir" | "beforeQuery" | "afterQuery"
		  >
		| undefined,
	ownsPool: boolean,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
	ensurePlugins(manifest);

	const driver = mariadbClient(pool, { ownsPool });
	const appliedManifest = applySchemaToManifest(manifest, undefined);
	const runtime: QueryRuntime = {
		manifest: appliedManifest,
		tableIndex: buildManifestIndex(appliedManifest, mariadbDialect),
		driver,
		dialect: mariadbDialect,
		...(options?.migrationsDir !== undefined
			? { migrationsDir: options.migrationsDir }
			: {}),
	};

	const executor = createSqliteExecutor(driver, pickExecutorOptions(options));
	return buildClient<TTables, TIncludes, TRowPayloads>(
		executor,
		runtime,
		ownsPool
			? async () => {
					await driver.close();
				}
			: noopDisconnect,
	);
}

function createNeoOrmSqliteClient<
	TTables extends Record<string, TableDef>,
	TIncludes extends Record<
		keyof TTables & string,
		unknown
	> = DefaultWithMap<TTables>,
	TRowPayloads extends Record<
		keyof TTables & string,
		Record<string, unknown>
	> = DefaultRowPayloadMap<TTables>,
>(
	manifest: Manifest,
	db: SqliteDatabaseLike,
	options:
		| Pick<
				NeoOrmClientOptions,
				"migrationsDir" | "sqlite" | "beforeQuery" | "afterQuery"
		  >
		| undefined,
	ownsDatabase: boolean,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
	ensurePlugins(manifest);

	const driver = sqliteClient(db, options?.sqlite);
	const appliedManifest = applySchemaToManifest(manifest, undefined);
	const runtime: QueryRuntime = {
		manifest: appliedManifest,
		tableIndex: buildManifestIndex(appliedManifest, sqliteDialect),
		driver,
		dialect: sqliteDialect,
		...(options?.migrationsDir !== undefined
			? { migrationsDir: options.migrationsDir }
			: {}),
	};

	const executor = createSqliteExecutor(driver, pickExecutorOptions(options));
	return buildClient<TTables, TIncludes, TRowPayloads>(
		executor,
		runtime,
		ownsDatabase
			? async () => {
					await driver.close();
				}
			: noopDisconnect,
	);
}

export type { SqliteClientOptions, SqliteDatabaseLike } from "./driver.js";
export type {
	QueryEvent,
	QueryHooks,
	QueryMethod,
	QueryResultEvent,
} from "./executor.js";
export type {
	DefaultRowPayloadMap,
	DefaultWithMap,
	PaginateCursor,
	TransactionClient,
	TransactionIsolationLevel,
	TransactionOptions,
	TypedNeoOrmClient,
	TypedTableRepository,
} from "./types.js";
