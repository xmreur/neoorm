/**
 * @packageDocumentation
 * NeoOrm — TypeScript-first PostgreSQL and SQLite ORM.
 *
 * Import the generated client from your `out` directory; use this entry for
 * config, migrations, codegen, and runtime client factories.
 */
export {
	buildDownSql,
	diffManifest,
	emptyManifest,
	explainNoMigrationSql,
	formatDestructiveWarnings,
	resolveMigrationSql,
} from "./codegen/diff-manifest.js";
export type {
	GenerateResult,
	GenerateStatus,
	GenerateSummary,
} from "./codegen/generate.js";
export {
	formatGenerateSummary,
	generateFromSchema,
	summarizeGenerateOutcome,
} from "./codegen/generate.js";
export type { SchemaValidationIssue } from "./codegen/schema-to-manifest.js";
export {
	schemaToManifest,
	validateManifest,
} from "./codegen/schema-to-manifest.js";
export type { NeoOrmConfig } from "./config.js";
export { defineConfig, loadConfig } from "./config.js";
export { postgresDialect } from "./dialect/postgres.js";
export type {
	Manifest,
	ManifestColumn,
	ManifestManyToMany,
	ManifestRelation,
	ManifestTable,
} from "./dialect/types.js";
export { introspectToManifest } from "./introspect/to-manifest.js";
export type {
	DbPushOptions,
	DbPushResult,
	MigrationRecord,
	MigrationStatus,
} from "./migrate/runner.js";
export {
	applySql,
	computeMigrationStatus,
	dbPush,
	formatMigrateStatus,
	listAppliedMigrations,
	listMigrationsOnDisk,
	migrateDeploy,
	migrateDown,
	migrateReset,
	migrateStatus,
	resetDatabaseSchema,
	revertMigration,
} from "./migrate/runner.js";
export type {
	DefaultRowPayloadMap,
	DefaultWithMap,
	NeoOrmClient,
	NeoOrmClientOptions,
	PaginateCursor,
	SqliteClientOptions,
	TableRepository,
	TransactionClient,
	TransactionIsolationLevel,
	TransactionOptions,
	TypedNeoOrmClient,
	TypedTableRepository,
} from "./runtime/client.js";
export {
	createNeoOrmClient,
	createNeoOrmClientFromPool,
} from "./runtime/client.js";
export {
	QueryErrorCode,
	type QueryErrorCodeValue,
	SchemaErrorCode,
	type SchemaErrorCodeValue,
} from "./runtime/error-codes.js";
export type {
	QueryErrorContext,
	QueryOperation,
	SchemaErrorContext,
} from "./runtime/errors.js";
export {
	CheckViolationError,
	createQueryError,
	ForeignKeyViolationError,
	formatQueryError,
	formatSchemaError,
	InvalidInputError,
	isCheckViolation,
	isForeignKeyViolation,
	isInvalidInput,
	isNeoOrmError,
	isNotNullViolation,
	isQueryCompileError,
	isQueryError,
	isSchemaDriftError,
	isSchemaError,
	isUniqueViolation,
	NeoOrmDriverError,
	NeoOrmError,
	NeoOrmQueryError,
	NeoOrmSchemaError,
	NotNullViolationError,
	QueryCompileError,
	SchemaDriftError,
	UniqueViolationError,
} from "./runtime/errors.js";
export { decodeCursor, encodeCursor } from "./runtime/query/cursor-codec.js";
export type { StripCapablePayload } from "./runtime/types.js";
export type { CursorInput, ScalarPkName } from "./schema/relation-types.js";
export type { PaginateArgs, PaginateResult } from "./schema/types.js";
