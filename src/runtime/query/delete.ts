import { postgresDialect, quoteIdentifier } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import {
	buildDeleteManyQuery,
	buildDeleteQuery,
	compileWhere,
	rowToTs,
} from "./compile.js";
import { type QueryRuntime, runQuery, runQueryOne } from "./execute.js";
import { loadRelations, type WithInput } from "./find.js";
import { primaryKeySqlName, requireScalarPrimaryKey } from "./primary-key.js";

export async function deleteRecord(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where: Record<string, unknown>;
		with?: Record<string, WithInput>;
	},
): Promise<Record<string, unknown> | null> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const { sql: whereSql, params } = compileWhere(
		manifest,
		table,
		args.where,
		postgresDialect,
	);

	if (!whereSql) {
		throw new Error("Delete requires a where clause");
	}

	const query = buildDeleteQuery(table, whereSql);
	const row = await runQueryOne(
		executor,
		runtime,
		{ operation: "delete", tableAccessor },
		query,
		params,
	);
	if (!row) return null;

	const result = rowToTs(table, row);

	if (args.with) {
		const [withLoaded] = await loadRelations(
			executor,
			runtime,
			table,
			[result],
			args.with,
		);
		return withLoaded ?? result;
	}

	return result;
}

export async function deleteManyRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: {
		where?: Record<string, unknown>;
	},
): Promise<number> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const { sql: whereSql, params } = compileWhere(
		manifest,
		table,
		args?.where,
		postgresDialect,
	);

	const query = buildDeleteManyQuery(table, whereSql);
	const pkSql = quoteIdentifier(primaryKeySqlName(table));
	const result = await runQuery(
		executor,
		runtime,
		{ operation: "delete", tableAccessor },
		`${query} RETURNING ${pkSql}`,
		params,
	);
	return result.length;
}

export async function deleteById(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	id: string,
): Promise<Record<string, unknown> | null> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const { tsName } = requireScalarPrimaryKey(table, "deleteById");
	return deleteRecord(executor, runtime, tableAccessor, {
		where: { [tsName]: id },
	});
}
