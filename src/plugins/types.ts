import type {
	Dialect,
	ManifestColumn,
} from "../dialect/types.js";
import type { ColumnBuilder, ColumnMeta } from "../schema/column.js";

export type PluginWhereCompileResult = {
	sql: string;
	params: unknown[];
};

export type PluginWhereOperator = {
	compile: (
		sqlCol: string,
		value: unknown,
		col: ManifestColumn,
		startParamIndex: number,
	) => PluginWhereCompileResult;
};

/** Column type contributed by a plugin (e.g. PostGIS geometry). */
export type ColumnTypePlugin = {
	readonly kind: string;
	createBuilder(options?: Record<string, unknown>): ColumnBuilder<unknown>;
	columnType(col: ManifestColumn): string;
	columnTsType(col: ManifestColumn): string;
	formatDefault?(col: ManifestColumn, value: unknown, dialect?: Dialect): string;
	selectExpression?(col: ManifestColumn): string;
	writeExpression?(col: ManifestColumn, paramIndex: number): string;
	serializeValue?(col: ManifestColumn, value: unknown, dialect?: Dialect): unknown;
	deserializeValue?(col: ManifestColumn, dbValue: unknown): unknown;
	updatedAtExpression?(col: ManifestColumn, dialect?: Dialect): string;
	whereOperators?: Record<string, PluginWhereOperator>;
	introspect?(pgDataType: string, udtName: string): boolean;
};

/** Plugin bundle: column types and optional PostgreSQL extensions. */
export type NeoOrmPlugin = {
	readonly name: string;
	readonly extensions?: readonly string[];
	readonly columnTypes: readonly ColumnTypePlugin[];
};

export type ExtendedColumnMeta = ColumnMeta & {
	kind: string;
	typeOptions?: Record<string, unknown>;
};
