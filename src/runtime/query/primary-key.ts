import { randomUUID } from "node:crypto";
import type {
	ManifestColumn,
	ManifestRelation,
	ManifestTable,
} from "../../dialect/types.js";
import { generateUuid, resolveUuidVersion } from "../../utils/uuid.js";
import { compileError } from "../compile-error.js";
import { QueryErrorCode } from "../error-codes.js";
import {
	columnBySqlName,
	columnByTsName,
	type TableIndex,
} from "./table-index.js";

const PK_KEY_SEP = "\0";

export function primaryKeyTsNames(
	table: ManifestTable,
	tableIndex?: TableIndex,
): string[] {
	return table.primaryKey
		.map((sqlName) => columnBySqlName(tableIndex, table, sqlName)?.tsName)
		.filter((name): name is string => name !== undefined);
}

export function primaryKeySqlName(table: ManifestTable, index = 0): string {
	const sqlName = table.primaryKey[index];
	if (!sqlName) {
		compileError(
			`Primary key index ${index} not found for table "${table.accessor}"`,
			{
				code: QueryErrorCode.missing_primary_key,
				tableAccessor: table.accessor,
				tableSqlName: table.sqlName,
			},
		);
	}
	return sqlName;
}

export type ScalarPrimaryKeyOperation =
	| "findById"
	| "updateById"
	| "deleteById"
	| "cursorPaginate"
	| "connect";

export function requireScalarPrimaryKey(
	table: ManifestTable,
	operation?: ScalarPrimaryKeyOperation,
	tableIndex?: TableIndex,
): {
	tsName: string;
	sqlName: string;
} {
	if (table.primaryKey.length !== 1) {
		const label = operation ?? "Operation";
		compileError(
			`${label} requires a single-column primary key on table "${table.accessor}"`,
			{
				code: QueryErrorCode.missing_primary_key,
				tableAccessor: table.accessor,
				tableSqlName: table.sqlName,
			},
		);
	}
	const sqlName = table.primaryKey[0];
	if (!sqlName) {
		compileError(
			`Primary key column not found for table "${table.accessor}"`,
			{
				code: QueryErrorCode.missing_primary_key,
				tableAccessor: table.accessor,
				tableSqlName: table.sqlName,
			},
		);
	}
	const col = columnBySqlName(tableIndex, table, sqlName);
	if (!col) {
		compileError(
			`Primary key column not found for table "${table.accessor}"`,
			{
				code: QueryErrorCode.missing_primary_key,
				tableAccessor: table.accessor,
				tableSqlName: table.sqlName,
			},
		);
	}
	return { tsName: col.tsName, sqlName: col.sqlName };
}

export function rowScalarPkValue(
	row: Record<string, unknown>,
	table: ManifestTable,
): string {
	if (table.primaryKey.length === 1) {
		const { tsName } = requireScalarPrimaryKey(table);
		const val = row[tsName];
		if (val == null) {
			compileError(`Missing primary key "${tsName}" on row`, {
				code: QueryErrorCode.missing_primary_key,
				tableAccessor: table.accessor,
				tableSqlName: table.sqlName,
				columnTsName: tsName,
			});
		}
		return String(val);
	}
	return rowPkKey(row, table);
}

export function resolvePkWhere(
	table: ManifestTable,
	id: string | Record<string, unknown>,
	tableIndex?: TableIndex,
): Record<string, unknown> {
	if (typeof id === "object" && id !== null) {
		const pkTsNames = primaryKeyTsNames(table, tableIndex);
		for (const tsName of pkTsNames) {
			if (!(tsName in id)) {
				compileError(
					`Missing primary key column "${tsName}" for table "${table.accessor}". The object must include all PK columns: ${pkTsNames.join(", ")}`,
					{
						code: QueryErrorCode.missing_primary_key,
						tableAccessor: table.accessor,
						tableSqlName: table.sqlName,
						columnTsName: tsName,
					},
				);
			}
		}
		return id;
	}

	if (table.primaryKey.length !== 1) {
		compileError(
			`Table "${table.accessor}" has a composite primary key. Pass an object with PK columns (${primaryKeyTsNames(table, tableIndex).join(", ")}) instead of a string.`,
			{
				code: QueryErrorCode.missing_primary_key,
				tableAccessor: table.accessor,
				tableSqlName: table.sqlName,
			},
		);
	}

	const { tsName } = requireScalarPrimaryKey(table, undefined, tableIndex);
	return { [tsName]: id };
}

export function rowPkKey(
	row: Record<string, unknown>,
	table: ManifestTable,
	tableIndex?: TableIndex,
): string {
	const tsNames = primaryKeyTsNames(table, tableIndex);
	if (tsNames.length === 0) {
		compileError(`No primary key defined for table "${table.accessor}"`, {
			code: QueryErrorCode.missing_primary_key,
			tableAccessor: table.accessor,
			tableSqlName: table.sqlName,
		});
	}
	return tsNames.map((name) => String(row[name] ?? "")).join(PK_KEY_SEP);
}

export function targetRelationPkSql(
	targetTable: ManifestTable,
	relation?: ManifestRelation,
): string {
	if (relation?.targetColumn) {
		return relation.targetColumn;
	}
	return primaryKeySqlName(targetTable);
}

export function resolveFkTargetSqlColumn(
	targetTable: ManifestTable,
	colRef: string | undefined,
	tableIndex?: TableIndex,
): string {
	if (!colRef) {
		return primaryKeySqlName(targetTable);
	}
	const col =
		columnByTsName(tableIndex, targetTable, colRef) ??
		columnBySqlName(tableIndex, targetTable, colRef);
	return col?.sqlName ?? colRef;
}

function generateTextId(tableAccessor: string): string {
	const prefix = tableAccessor.replace(/s$/, "").slice(0, 4);
	return `${prefix}_${randomUUID()}`;
}

export function defaultPrimaryKeyValue(
	table: ManifestTable,
	col: ManifestColumn,
): string {
	if (col.kind === "uuid") {
		return generateUuid(resolveUuidVersion(col));
	}
	return generateTextId(table.accessor);
}

export function scalarPkAvailable(
	table: ManifestTable,
	data: Record<string, unknown>,
	tableIndex?: TableIndex,
): boolean {
	if (table.primaryKey.length === 0) return false;
	for (const sqlName of table.primaryKey) {
		const col = columnBySqlName(tableIndex, table, sqlName);
		if (!col) return false;
		if (col.kind === "serial" || col.generated) return false;
		const current = data[col.tsName];
		if (current === undefined || current === null) return false;
	}
	return true;
}

export function fillMissingPrimaryKeys(
	table: ManifestTable,
	data: Record<string, unknown>,
	tableIndex?: TableIndex,
): void {
	let needsFill = false;
	for (const sqlName of table.primaryKey) {
		const col = columnBySqlName(tableIndex, table, sqlName);
		if (!col || col.kind === "serial" || col.generated) continue;
		const current = data[col.tsName];
		if (current === undefined || current === null) {
			needsFill = true;
			break;
		}
	}
	if (!needsFill) return;

	for (const sqlName of table.primaryKey) {
		const col = columnBySqlName(tableIndex, table, sqlName);
		if (!col || col.kind === "serial" || col.generated) continue;
		const current = data[col.tsName];
		if (current !== undefined && current !== null) continue;
		data[col.tsName] = defaultPrimaryKeyValue(table, col);
	}
}
