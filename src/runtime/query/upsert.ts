import { postgresDialect } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import {
	buildUpsertQuery,
	dataToSqlValues,
	dataToUpdateAssignments,
	serializeColumnValue,
} from "./compile.js";
import { type QueryRuntime, runExecute, runQueryOne } from "./execute.js";
import { loadRelations, type WithInput } from "./find.js";
import { mapRowToTs } from "./map-row.js";
import { fetchRowsByWhere } from "./mutation-returning.js";
import { fillMissingPrimaryKeys } from "./primary-key.js";
import { getTableIndex, requireTable } from "./table-index.js";
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
	const table = requireTable(manifest, tableAccessor, "select");

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const { constraint, where: uniqueWhere } = assertUniqueWhere(
		table,
		args.where,
		"upsert",
		tableIndex,
	);

	const createData = { ...args.create, ...uniqueWhere };
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
	const exprSets = updatedAtSetExpressions(table, tableIndex, dialect);

	const upsertSql = buildUpsertQuery(
		table,
		insertKeys,
		updateKeys,
		constraint.sqlColumns,
		exprSets,
		runtime.tableIndex,
		dialect,
		updateOps,
		constraint.whereSql,
	);
	const upsertParams = [...insertValues, ...updateValues];

	let result: Record<string, unknown>;
	if (dialect.supportsReturning) {
		const row = await runQueryOne(
			executor,
			runtime,
			{ operation: "upsert", tableAccessor },
			upsertSql,
			upsertParams,
		);
		result = mapRowToTs(tableIndex, table, row);
	} else {
		await runExecute(
			executor,
			runtime,
			{ operation: "upsert", tableAccessor },
			upsertSql,
			upsertParams,
		);
		const lookups = Object.entries(uniqueWhere);
		const lookupParams: unknown[] = [];
		const whereParts = lookups.map(([tsName, value], i) => {
			const col = table.columns.find((c) => c.tsName === tsName);
			lookupParams.push(
				col ? serializeColumnValue(col, value, dialect) : value,
			);
			return `${dialect.quoteIdentifier(col?.sqlName ?? tsName)} = ${dialect.placeholder(i + 1)}`;
		});
		if (constraint.whereSql) {
			whereParts.push(`(${constraint.whereSql})`);
		}
		const rows = await fetchRowsByWhere(
			executor,
			runtime,
			table,
			tableAccessor,
			whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "",
			lookupParams,
			"upsert",
		);
		const reloaded = rows[0];
		if (!reloaded) {
			result = { ...createData, ...updateData };
		} else {
			result = reloaded;
		}
	}

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
