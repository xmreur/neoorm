import { postgresDialect } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import {
	buildUpsertQuery,
	dataToSqlValues,
	dataToUpdateAssignments,
	mapRowToTs,
	upsertAtomicValues,
} from "./compile.js";
import { type QueryRuntime, runQueryOne } from "./execute.js";
import { loadRelations, type WithInput } from "./find.js";
import { fillMissingPrimaryKeys } from "./primary-key.js";
import { getTableIndex } from "./table-index.js";
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
	const dialect = runtime.dialect ?? postgresDialect;
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
	fillMissingPrimaryKeys(table, createData, tableIndex);

	const { keys: insertKeys, values: insertValues } = dataToSqlValues(
		table,
		createData,
		undefined,
		runtime.tableIndex,
		dialect,
	);

	const updateData = { ...args.update };
	stripUpdatedAtFromData(table, updateData, tableIndex);
	const {
		keys: updateKeys,
		ops: updateOps,
		values: updateValues,
	} = dataToUpdateAssignments(
		table,
		updateData,
		{ excludePrimary: true },
		runtime.tableIndex,
		dialect,
	);
	const exprSets = updatedAtSetExpressions(table, tableIndex);

	const upsertSql = buildUpsertQuery(
		table,
		insertKeys,
		updateKeys,
		constraint.sqlColumns,
		exprSets,
		runtime.tableIndex,
		dialect,
		updateOps,
	);
	const row = await runQueryOne(
		executor,
		runtime,
		{ operation: "upsert", tableAccessor },
		upsertSql,
		[...insertValues, ...upsertAtomicValues(updateOps, updateValues)],
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
