/** Dialect-agnostic query error codes. */
export const QueryErrorCode = {
	// Runtime constraint / DB errors
	unique_violation: "unique_violation",
	not_null_violation: "not_null_violation",
	foreign_key_violation: "foreign_key_violation",
	check_violation: "check_violation",
	invalid_input: "invalid_input",
	relation_not_found: "relation_not_found",
	column_not_found: "column_not_found",
	empty_returning: "empty_returning",
	connection_error: "connection_error",
	driver_error: "driver_error",

	// Compile-time query errors
	unknown_table: "unknown_table",
	unknown_column: "unknown_column",
	unknown_relation: "unknown_relation",
	unique_where_invalid: "unique_where_invalid",
	where_required: "where_required",
	invalid_args: "invalid_args",
	invalid_cursor: "invalid_cursor",
	invalid_nested_write: "invalid_nested_write",
	missing_primary_key: "missing_primary_key",
	unsupported_operation: "unsupported_operation",
} as const;

export type QueryErrorCodeValue =
	(typeof QueryErrorCode)[keyof typeof QueryErrorCode];

/** Schema / migration / config error codes. */
export const SchemaErrorCode = {
	invalid_schema_export: "invalid_schema_export",
	unknown_column: "unknown_column",
	invalid_updated_at: "invalid_updated_at",
	unknown_table_accessor: "unknown_table_accessor",
	missing_primary_key: "missing_primary_key",
	invalid_column: "invalid_column",
	unknown_m2m_target: "unknown_m2m_target",
	unknown_m2m_through: "unknown_m2m_through",
	junction_collision: "junction_collision",
	unknown_junction_column: "unknown_junction_column",
	duplicate_inverse: "duplicate_inverse",
	schema_compile_error: "schema_compile_error",
	duplicate_table_sql_name: "duplicate_table_sql_name",
	unknown_fk_target: "unknown_fk_target",
	unknown_fk_column: "unknown_fk_column",
	unknown_column_kind: "unknown_column_kind",
	migration_failed: "migration_failed",
	migration_guard: "migration_guard",
	invalid_config: "invalid_config",
	plugin_error: "plugin_error",
} as const;

export type SchemaErrorCodeValue =
	(typeof SchemaErrorCode)[keyof typeof SchemaErrorCode];

export const SCHEMA_DRIFT_QUERY_CODES = new Set<QueryErrorCodeValue>([
	QueryErrorCode.relation_not_found,
	QueryErrorCode.column_not_found,
	QueryErrorCode.foreign_key_violation,
]);
