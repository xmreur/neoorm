import type { Executor } from "../executor.js";
import { buildUpsertQuery, dataToSqlValues, mapRowToTs } from "./compile.js";
import { type QueryRuntime, runQueryOne } from "./execute.js";
import { loadRelations, type WithInput } from "./find.js";
import { fillMissingPrimaryKeys } from "./primary-key.js";
import { columnByTsName, getTableIndex } from "./table-index.js";
import { assertUniqueWhere } from "./unique.js";
import {
	stripUpdatedAtFromData,
	updatedAtSetExpressions,
} from "./updated-at.js";

export async function upsertRecord(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where: Record<string, unknown>;
		create: Record<string, unknown>;
		update: Record<string, unknown>;
		with?: Record<string, WithInput>;
	},
): Promise<Record<string, unknown>> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const constraint = assertUniqueWhere(
		table,
		args.where,
		"upsert",
		tableIndex,
	);

	const createData = { ...args.create, ...args.where };
	fillMissingPrimaryKeys(table, createData);

	const { keys: insertKeys, values: insertValues } = dataToSqlValues(
		table,
		createData,
		undefined,
		runtime.tableIndex,
	);

	const updateData = { ...args.update };
	stripUpdatedAtFromData(table, updateData);
	const updateKeys = Object.keys(updateData).filter((key) => {
		const col = columnByTsName(tableIndex, table, key);
		return (
			col !== undefined && !col.primary && updateData[key] !== undefined
		);
	});
	const exprSets = updatedAtSetExpressions(table);

	const upsertSql = buildUpsertQuery(
		table,
		insertKeys,
		updateKeys,
		constraint.sqlColumns,
		exprSets,
		runtime.tableIndex,
	);
	const row = await runQueryOne(
		executor,
		runtime,
		{ operation: "upsert", tableAccessor },
		upsertSql,
		insertValues,
	);

	const result = mapRowToTs(
		getTableIndex(runtime.tableIndex, tableAccessor),
		table,
		row,
	);

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
