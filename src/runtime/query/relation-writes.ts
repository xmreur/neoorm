import {
	postgresDialect,
	quoteIdentifier,
	tableRef,
} from "../../dialect/postgres.js";
import type {
	Manifest,
	ManifestManyToMany,
	ManifestRelation,
	ManifestTable,
} from "../../dialect/types.js";
import { compileError } from "../compile-error.js";
import { queryCompileError } from "../error-builders.js";
import { QueryErrorCode } from "../error-codes.js";
import type { QueryOperation } from "../errors.js";
import type { Executor } from "../executor.js";
import {
	buildInsertManyQuery,
	buildInsertManyValueRows,
	dataToSqlValues,
} from "./compile.js";
import { type QueryRuntime, runQuery } from "./execute.js";
import type { WithInput } from "./find.js";
import { findOrCreatePk } from "./find-or-create.js";
import { findM2M, findRelation, tableOwnsFkColumn } from "./manifest-lookup.js";
import {
	fillMissingPrimaryKeys,
	primaryKeySqlName,
	requireScalarPrimaryKey,
	rowScalarPkValue,
	targetRelationPkSql,
} from "./primary-key.js";
import {
	columnBySqlName,
	columnByTsName,
	getTableIndex,
	type ManifestIndex,
	requireTable,
	requireTsColumn,
	type TableIndex,
} from "./table-index.js";

const RELATION_WRITE_KEYS = [
	"delete",
	"connect",
	"disconnect",
	"set",
	"create",
	"connectOrCreate",
] as const;

export type CreateRunner = (
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		data: Record<string, unknown>;
		with?: Record<string, WithInput>;
	},
) => Promise<Record<string, unknown>>;

export type ParsedRelationWrite = {
	relationName: string;
	value: Record<string, unknown>;
};

export type SplitDataResult = {
	scalarData: Record<string, unknown>;
	relationWrites: ParsedRelationWrite[];
};

function isRelationWriteKey(key: string): boolean {
	return (RELATION_WRITE_KEYS as readonly string[]).includes(key);
}

function isRelationWriteObject(
	value: unknown,
): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return false;
	const keys = Object.keys(value);
	if (keys.length === 0) return false;
	return keys.every(isRelationWriteKey);
}

function requireRelationWriteObject(
	relationName: string,
	value: unknown,
	table: ManifestTable,
	operation: QueryOperation,
): asserts value is Record<string, unknown> {
	if (isRelationWriteObject(value)) return;

	const allowed = RELATION_WRITE_KEYS.join(", ");
	let detail = `Relation "${relationName}" requires a nested write object (${allowed})`;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const unknownKeys = Object.keys(value).filter(
			(k) => !isRelationWriteKey(k),
		);
		if (unknownKeys.length > 0) {
			detail = `Relation "${relationName}" nested write has unknown keys: ${unknownKeys.join(", ")}. Allowed: ${allowed}`;
		}
	}

	compileError(detail, {
		code: QueryErrorCode.invalid_nested_write,
		operation,
		tableAccessor: table.accessor,
		tableSqlName: table.sqlName,
		columnTsName: relationName,
		suggestions: [...RELATION_WRITE_KEYS],
	});
}

function isRelationField(
	manifest: Manifest,
	tableAccessor: string,
	table: ManifestTable,
	key: string,
	tableIndex?: TableIndex,
): boolean {
	if (findRelation(table, key, tableIndex)) return true;
	return findM2M(manifest, tableAccessor, key) !== undefined;
}

function connectPkError(
	table: ManifestTable,
	pkTsName: string,
	detail: string,
): never {
	compileError(detail, {
		code: QueryErrorCode.missing_primary_key,
		tableAccessor: table.accessor,
		tableSqlName: table.sqlName,
		columnTsName: pkTsName,
	});
}

function readConnectPk(
	item: unknown,
	pkTsName: string,
	table: ManifestTable,
): string {
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		connectPkError(
			table,
			pkTsName,
			`Relation connect requires { ${pkTsName}: ... } for table "${table.accessor}"`,
		);
	}
	const id = (item as Record<string, unknown>)[pkTsName];
	if (id == null) {
		connectPkError(
			table,
			pkTsName,
			`Relation connect requires primary key "${pkTsName}" for table "${table.accessor}"`,
		);
	}
	return String(id);
}

function normalizeIdList(
	value: unknown,
	pkTsName: string,
	table: ManifestTable,
): string[] {
	if (value == null || value === false) return [];
	if (Array.isArray(value)) {
		return value.map((item) => readConnectPk(item, pkTsName, table));
	}
	return [readConnectPk(value, pkTsName, table)];
}

function normalizeConnectIds(
	runtime: QueryRuntime,
	targetAccessor: string,
	value: unknown,
): string[] {
	const table = requireTable(runtime.manifest, targetAccessor, "select");
	const { tsName } = requireScalarPrimaryKey(
		table,
		"connect",
		getTableIndex(runtime.tableIndex, targetAccessor),
	);
	return normalizeIdList(value, tsName, table);
}

function normalizeCreateList(value: unknown): Record<string, unknown>[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value as Record<string, unknown>[];
	}
	return [value as Record<string, unknown>];
}

export function splitScalarsAndRelationWrites(
	manifest: Manifest,
	tableAccessor: string,
	table: ManifestTable,
	data: Record<string, unknown>,
	manifestIndex?: ManifestIndex,
	operation: QueryOperation = "insert",
): SplitDataResult {
	const tableIndex = getTableIndex(manifestIndex, tableAccessor);
	const scalarData: Record<string, unknown> = {};
	const relationWrites: ParsedRelationWrite[] = [];

	for (const [key, value] of Object.entries(data)) {
		const col = columnByTsName(tableIndex, table, key);
		if (col) {
			scalarData[key] = value;
			continue;
		}

		if (isRelationField(manifest, tableAccessor, table, key, tableIndex)) {
			requireRelationWriteObject(key, value, table, operation);
			relationWrites.push({ relationName: key, value });
			continue;
		}

		requireTsColumn(tableIndex, table, key, "data", operation);
	}

	return { scalarData, relationWrites };
}

export async function resolveConnectOrCreate(
	executor: Executor,
	runtime: QueryRuntime,
	targetAccessor: string,
	items: Array<{
		where: Record<string, unknown>;
		create: Record<string, unknown>;
	}>,
): Promise<string[]> {
	const ids: string[] = [];
	for (const item of items) {
		const id = await findOrCreatePk(
			executor,
			runtime,
			targetAccessor,
			item,
		);
		ids.push(id);
	}
	return ids;
}

async function insertM2MLinks(
	executor: Executor,
	runtime: QueryRuntime,
	m2m: ManifestManyToMany,
	parentAccessor: string,
	parentId: string,
	otherIds: string[],
): Promise<void> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const throughTable = manifest.tables[m2m.throughAccessor];
	if (!throughTable) return;

	const throughIndex = getTableIndex(
		runtime.tableIndex,
		throughTable.accessor,
	);
	const isLeft = m2m.leftAccessor === parentAccessor;
	const leftCol = columnBySqlName(
		throughIndex,
		throughTable,
		isLeft ? m2m.leftFkColumn : m2m.rightFkColumn,
	);
	const rightCol = columnBySqlName(
		throughIndex,
		throughTable,
		isLeft ? m2m.rightFkColumn : m2m.leftFkColumn,
	);
	if (!leftCol || !rightCol) return;

	const uniqueOtherIds = [...new Set(otherIds)];
	if (uniqueOtherIds.length === 0) return;

	const now = new Date();
	const scalarRows: Record<string, unknown>[] = [];
	for (const otherId of uniqueOtherIds) {
		const leftId = isLeft ? parentId : otherId;
		const rightId = isLeft ? otherId : parentId;
		const data: Record<string, unknown> = {
			[leftCol.tsName]: leftId,
			[rightCol.tsName]: rightId,
		};
		for (const col of throughTable.columns) {
			if (col.tsName in data) continue;
			if (col.defaultNow) {
				data[col.tsName] = now;
			}
		}
		fillMissingPrimaryKeys(throughTable, data, throughIndex);
		scalarRows.push(data);
	}

	const keySet = new Set<string>();
	for (const row of scalarRows) {
		const { keys } = dataToSqlValues(
			throughTable,
			row,
			undefined,
			runtime.tableIndex,
			dialect,
		);
		for (const key of keys) keySet.add(key);
	}
	const dataKeys = throughTable.columns
		.filter((col) => keySet.has(col.tsName))
		.map((col) => col.tsName);
	if (dataKeys.length === 0) return;

	const rowValues = scalarRows.map((row) => {
		const { keys, values } = dataToSqlValues(
			throughTable,
			row,
			undefined,
			runtime.tableIndex,
			dialect,
		);
		const valueByKey = new Map(keys.map((key, i) => [key, values[i]]));
		return dataKeys.map((key) => valueByKey.get(key));
	});
	const { valueRows, values } = buildInsertManyValueRows(
		throughTable,
		dataKeys,
		rowValues,
		runtime.tableIndex,
	);
	const sql = buildInsertManyQuery(
		throughTable,
		dataKeys,
		valueRows,
		runtime.tableIndex,
		true,
		dialect,
	);
	await runQuery(
		executor,
		runtime,
		{ operation: "insert", tableAccessor: throughTable.accessor },
		sql,
		values,
	);
}

async function insertJunctionRows(
	executor: Executor,
	runtime: QueryRuntime,
	throughAccessor: string,
	leftFkCol: string,
	rightFkCol: string,
	leftId: string,
	rightIds: string[],
): Promise<void> {
	const { manifest } = runtime;
	const m2m = manifest.manyToMany.find(
		(m) => m.throughAccessor === throughAccessor,
	);
	if (!m2m) {
		compileError(`Unknown junction table: ${throughAccessor}`);
	}
	const parentAccessor =
		m2m.leftFkColumn === leftFkCol ? m2m.leftAccessor : m2m.rightAccessor;
	await insertM2MLinks(
		executor,
		runtime,
		m2m,
		parentAccessor,
		leftId,
		rightIds,
	);
}

async function deleteJunctionRows(
	executor: Executor,
	runtime: QueryRuntime,
	m2m: ManifestManyToMany,
	parentAccessor: string,
	parentId: string,
	rightIds?: string[],
): Promise<void> {
	const { manifest } = runtime;
	const throughTable = manifest.tables[m2m.throughAccessor];
	if (!throughTable) return;

	const throughIndex = getTableIndex(
		runtime.tableIndex,
		throughTable.accessor,
	);
	const isLeft = m2m.leftAccessor === parentAccessor;
	const parentFkCol = isLeft ? m2m.leftFkColumn : m2m.rightFkColumn;
	const otherFkCol = isLeft ? m2m.rightFkColumn : m2m.leftFkColumn;

	const parentCol = columnBySqlName(throughIndex, throughTable, parentFkCol);
	const otherCol = columnBySqlName(throughIndex, throughTable, otherFkCol);
	if (!parentCol || !otherCol) return;

	const params: unknown[] = [parentId];
	let sql = `DELETE FROM ${tableRef(throughTable)} WHERE ${quoteIdentifier(parentCol.sqlName)} = $1`;

	if (rightIds && rightIds.length > 0) {
		const placeholders = rightIds.map((_, i) => `$${i + 2}`).join(", ");
		sql += ` AND ${quoteIdentifier(otherCol.sqlName)} IN (${placeholders})`;
		params.push(...rightIds);
	}

	await runQuery(
		executor,
		runtime,
		{ operation: "delete", tableAccessor: throughTable.accessor },
		sql,
		params,
	);
}

function childFkColumnMeta(
	targetTable: ManifestTable,
	relation: ManifestRelation,
	tableIndex?: TableIndex,
) {
	const col =
		columnByTsName(tableIndex, targetTable, relation.fkColumn) ??
		columnBySqlName(tableIndex, targetTable, relation.fkSqlColumn);
	if (!col) {
		compileError(`FK column not found for relation ${relation.name}`);
	}
	return col;
}

async function connectInverseMany(
	executor: Executor,
	runtime: QueryRuntime,
	relation: ManifestRelation,
	parentId: string,
	childIds: string[],
): Promise<void> {
	const { manifest } = runtime;
	const targetTable = manifest.tables[relation.targetAccessor];
	if (!targetTable || childIds.length === 0) return;

	const fkCol = childFkColumnMeta(
		targetTable,
		relation,
		getTableIndex(runtime.tableIndex, targetTable.accessor),
	);
	const placeholders = childIds.map((_, i) => `$${i + 2}`).join(", ");
	const targetPkCol = quoteIdentifier(
		targetRelationPkSql(targetTable, relation),
	);
	await runQuery(
		executor,
		runtime,
		{ operation: "update", tableAccessor: relation.targetAccessor },
		`UPDATE ${tableRef(targetTable)} SET ${quoteIdentifier(fkCol.sqlName)} = $1 WHERE ${targetPkCol} IN (${placeholders})`,
		[parentId, ...childIds],
	);
}

async function disconnectInverseMany(
	executor: Executor,
	runtime: QueryRuntime,
	relation: ManifestRelation,
	parentId: string,
	childIds: string[] | undefined,
): Promise<void> {
	const { manifest } = runtime;
	const targetTable = manifest.tables[relation.targetAccessor];
	if (!targetTable) return;

	const fkCol = childFkColumnMeta(
		targetTable,
		relation,
		getTableIndex(runtime.tableIndex, targetTable.accessor),
	);
	if (!fkCol.nullable) {
		compileError(
			`Cannot disconnect relation ${relation.name}: FK column is not nullable`,
		);
	}

	const params: unknown[] = [parentId];
	let sql = `UPDATE ${tableRef(targetTable)} SET ${quoteIdentifier(fkCol.sqlName)} = NULL WHERE ${quoteIdentifier(fkCol.sqlName)} = $1`;

	if (childIds && childIds.length > 0) {
		const placeholders = childIds.map((_, i) => `$${i + 2}`).join(", ");
		const targetPkCol = quoteIdentifier(
			targetRelationPkSql(targetTable, relation),
		);
		sql += ` AND ${targetPkCol} IN (${placeholders})`;
		params.push(...childIds);
	}

	await runQuery(
		executor,
		runtime,
		{ operation: "update", tableAccessor: relation.targetAccessor },
		sql,
		params,
	);
}

async function setInverseMany(
	executor: Executor,
	runtime: QueryRuntime,
	relation: ManifestRelation,
	parentId: string,
	childIds: string[],
): Promise<void> {
	await disconnectInverseMany(
		executor,
		runtime,
		relation,
		parentId,
		undefined,
	);
	await connectInverseMany(executor, runtime, relation, parentId, childIds);
}

async function deleteInverseManyChildren(
	executor: Executor,
	runtime: QueryRuntime,
	relation: ManifestRelation,
	parentId: string,
	childIds: string[] | undefined,
): Promise<void> {
	const { manifest } = runtime;
	const targetTable = manifest.tables[relation.targetAccessor];
	if (!targetTable) return;

	const fkCol = childFkColumnMeta(
		targetTable,
		relation,
		getTableIndex(runtime.tableIndex, targetTable.accessor),
	);
	const targetPkCol = quoteIdentifier(
		targetRelationPkSql(targetTable, relation),
	);
	const params: unknown[] = [parentId];
	let sql = `DELETE FROM ${tableRef(targetTable)} WHERE ${quoteIdentifier(fkCol.sqlName)} = $1`;

	if (childIds && childIds.length > 0) {
		const placeholders = childIds.map((_, i) => `$${i + 2}`).join(", ");
		sql += ` AND ${targetPkCol} IN (${placeholders})`;
		params.push(...childIds);
	}

	await runQuery(
		executor,
		runtime,
		{ operation: "delete", tableAccessor: relation.targetAccessor },
		sql,
		params,
	);
}

async function listM2MLinkedIds(
	executor: Executor,
	runtime: QueryRuntime,
	m2m: ManifestManyToMany,
	parentAccessor: string,
	parentId: string,
): Promise<string[]> {
	const { manifest } = runtime;
	const throughTable = manifest.tables[m2m.throughAccessor];
	if (!throughTable) return [];

	const throughIndex = getTableIndex(
		runtime.tableIndex,
		throughTable.accessor,
	);
	const isLeft = m2m.leftAccessor === parentAccessor;
	const parentFkCol = isLeft ? m2m.leftFkColumn : m2m.rightFkColumn;
	const otherFkCol = isLeft ? m2m.rightFkColumn : m2m.leftFkColumn;

	const parentCol = columnBySqlName(throughIndex, throughTable, parentFkCol);
	const otherCol = columnBySqlName(throughIndex, throughTable, otherFkCol);
	if (!parentCol || !otherCol) return [];

	const rows = await runQuery<Record<string, unknown>>(
		executor,
		runtime,
		{ operation: "select", tableAccessor: throughTable.accessor },
		`SELECT ${quoteIdentifier(otherCol.sqlName)} FROM ${tableRef(throughTable)} WHERE ${quoteIdentifier(parentCol.sqlName)} = $1`,
		[parentId],
	);

	return rows.map((row) =>
		String(row[otherCol.sqlName] ?? row[otherCol.tsName]),
	);
}

async function deleteM2MRelated(
	executor: Executor,
	runtime: QueryRuntime,
	m2m: ManifestManyToMany,
	tableAccessor: string,
	parentId: string,
	relatedIds: string[] | undefined,
): Promise<void> {
	const { manifest } = runtime;
	const isLeft = m2m.leftAccessor === tableAccessor;
	const targetAccessor = isLeft ? m2m.rightAccessor : m2m.leftAccessor;
	const targetTable = manifest.tables[targetAccessor];
	if (!targetTable) return;

	const ids =
		relatedIds ??
		(await listM2MLinkedIds(
			executor,
			runtime,
			m2m,
			tableAccessor,
			parentId,
		));
	if (ids.length === 0) return;

	await deleteJunctionRows(
		executor,
		runtime,
		m2m,
		tableAccessor,
		parentId,
		ids,
	);

	const targetPkCol = quoteIdentifier(primaryKeySqlName(targetTable));
	const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
	await runQuery(
		executor,
		runtime,
		{ operation: "delete", tableAccessor: targetAccessor },
		`DELETE FROM ${tableRef(targetTable)} WHERE ${targetPkCol} IN (${placeholders})`,
		ids,
	);
}

async function executeToOneWrite(
	executor: Executor,
	runtime: QueryRuntime,
	table: ManifestTable,
	scalarData: Record<string, unknown>,
	relationName: string,
	value: Record<string, unknown>,
	runCreate: CreateRunner,
): Promise<void> {
	const { manifest } = runtime;
	const tableIndex = getTableIndex(runtime.tableIndex, table.accessor);
	const rel = findRelation(table, relationName, tableIndex);
	if (!rel || rel.cardinality !== "one") return;

	if ("connect" in value) {
		const ids = normalizeConnectIds(
			runtime,
			rel.targetAccessor,
			value.connect,
		);
		const id = ids[0];
		if (id === undefined) {
			compileError(
				`Relation connect requires a primary key for table "${rel.targetAccessor}"`,
				{
					code: QueryErrorCode.missing_primary_key,
					tableAccessor: rel.targetAccessor,
				},
			);
		}
		if (ids.length > 1) {
			compileError(
				`Cannot connect more than one record to to-one relation ${relationName}`,
			);
		}
		scalarData[rel.fkColumn] = id;
		return;
	}

	if ("disconnect" in value) {
		const fkCol =
			columnByTsName(tableIndex, table, rel.fkColumn) ??
			columnBySqlName(tableIndex, table, rel.fkSqlColumn);
		if (fkCol && !fkCol.nullable) {
			compileError(
				`Cannot disconnect relation ${relationName}: FK column is not nullable`,
			);
		}
		scalarData[rel.fkColumn] = null;
		return;
	}

	if ("create" in value) {
		const created = await runCreate(executor, runtime, rel.targetAccessor, {
			data: value["create"] as Record<string, unknown>,
		});
		const targetTable = manifest.tables[rel.targetAccessor];
		if (!targetTable) compileError(`Unknown table: ${rel.targetAccessor}`);
		scalarData[rel.fkColumn] = rowScalarPkValue(created, targetTable);
	}
}

export async function applyToOnePreWrites(
	executor: Executor,
	runtime: QueryRuntime,
	table: ManifestTable,
	scalarData: Record<string, unknown>,
	relationWrites: ParsedRelationWrite[],
	runCreate: CreateRunner,
): Promise<void> {
	if (relationWrites.length === 0) return;

	for (const write of relationWrites) {
		const rel = findRelation(table, write.relationName);
		if (!rel || rel.cardinality !== "one" || !tableOwnsFkColumn(table, rel))
			continue;
		await executeToOneWrite(
			executor,
			runtime,
			table,
			scalarData,
			write.relationName,
			write.value,
			runCreate,
		);
	}
}

async function executeM2MWrite(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	parentId: string,
	relationName: string,
	value: Record<string, unknown>,
): Promise<void> {
	const { manifest } = runtime;
	const m2m = findM2M(manifest, tableAccessor, relationName);
	if (!m2m) return;

	const isLeft = m2m.leftAccessor === tableAccessor;
	const targetAccessor = isLeft ? m2m.rightAccessor : m2m.leftAccessor;

	if ("delete" in value) {
		const del = value["delete"];
		if (del === true) {
			await deleteM2MRelated(
				executor,
				runtime,
				m2m,
				tableAccessor,
				parentId,
				undefined,
			);
		} else {
			const ids = normalizeConnectIds(runtime, targetAccessor, del);
			await deleteM2MRelated(
				executor,
				runtime,
				m2m,
				tableAccessor,
				parentId,
				ids,
			);
		}
	}

	if ("disconnect" in value) {
		const disconnect = value["disconnect"];
		if (disconnect === true) {
			await deleteJunctionRows(
				executor,
				runtime,
				m2m,
				tableAccessor,
				parentId,
			);
		} else {
			const ids = normalizeConnectIds(
				runtime,
				targetAccessor,
				disconnect,
			);
			await deleteJunctionRows(
				executor,
				runtime,
				m2m,
				tableAccessor,
				parentId,
				ids,
			);
		}
	}

	if ("set" in value) {
		const ids = normalizeConnectIds(runtime, targetAccessor, value["set"]);
		await deleteJunctionRows(
			executor,
			runtime,
			m2m,
			tableAccessor,
			parentId,
		);
		if (ids.length > 0) {
			await insertM2MLinks(
				executor,
				runtime,
				m2m,
				tableAccessor,
				parentId,
				ids,
			);
		}
		return;
	}

	if ("connect" in value) {
		const ids = normalizeConnectIds(
			runtime,
			targetAccessor,
			value["connect"],
		);
		if (ids.length > 0) {
			await insertM2MLinks(
				executor,
				runtime,
				m2m,
				tableAccessor,
				parentId,
				ids,
			);
		}
	}

	if ("connectOrCreate" in value) {
		const items = value["connectOrCreate"] as Array<{
			where: Record<string, unknown>;
			create: Record<string, unknown>;
		}>;
		const ids = await resolveConnectOrCreate(
			executor,
			runtime,
			targetAccessor,
			items,
		);
		if (ids.length > 0) {
			await insertM2MLinks(
				executor,
				runtime,
				m2m,
				tableAccessor,
				parentId,
				ids,
			);
		}
	}
}

async function executeInverseManyWrite(
	executor: Executor,
	runtime: QueryRuntime,
	table: ManifestTable,
	parentId: string,
	relationName: string,
	value: Record<string, unknown>,
	runCreate: CreateRunner,
): Promise<void> {
	const { manifest } = runtime;
	const rel = findRelation(table, relationName);
	if (
		!rel ||
		rel.cardinality !== "many" ||
		findM2M(manifest, table.accessor, relationName)
	) {
		return;
	}

	if ("delete" in value) {
		const del = value["delete"];
		if (del === true) {
			await deleteInverseManyChildren(
				executor,
				runtime,
				rel,
				parentId,
				undefined,
			);
		} else {
			const ids = normalizeConnectIds(runtime, rel.targetAccessor, del);
			await deleteInverseManyChildren(
				executor,
				runtime,
				rel,
				parentId,
				ids,
			);
		}
	}

	if ("disconnect" in value) {
		const disconnect = value["disconnect"];
		if (disconnect === true) {
			await disconnectInverseMany(
				executor,
				runtime,
				rel,
				parentId,
				undefined,
			);
		} else {
			const ids = normalizeConnectIds(
				runtime,
				rel.targetAccessor,
				disconnect,
			);
			await disconnectInverseMany(executor, runtime, rel, parentId, ids);
		}
	}

	if ("set" in value) {
		const ids = normalizeConnectIds(
			runtime,
			rel.targetAccessor,
			value["set"],
		);
		await setInverseMany(executor, runtime, rel, parentId, ids);
		return;
	}

	if ("connect" in value) {
		const ids = normalizeConnectIds(
			runtime,
			rel.targetAccessor,
			value["connect"],
		);
		await connectInverseMany(executor, runtime, rel, parentId, ids);
	}

	if ("create" in value) {
		const items = normalizeCreateList(value["create"]);
		for (const item of items) {
			await runCreate(executor, runtime, rel.targetAccessor, {
				data: {
					...item,
					[rel.fkColumn]: parentId,
				},
			});
		}
	}
}

async function executeInverseOneWrite(
	executor: Executor,
	runtime: QueryRuntime,
	table: ManifestTable,
	parentId: string,
	relationName: string,
	value: Record<string, unknown>,
	runCreate: CreateRunner,
): Promise<void> {
	const { manifest } = runtime;
	const rel = findRelation(table, relationName);
	if (!rel || rel.cardinality !== "one" || tableOwnsFkColumn(table, rel))
		return;

	const targetTable = manifest.tables[rel.targetAccessor];
	if (!targetTable) return;

	const fkCol = childFkColumnMeta(targetTable, rel);

	if ("delete" in value) {
		const del = value["delete"];
		if (del === true) {
			await deleteInverseManyChildren(
				executor,
				runtime,
				rel,
				parentId,
				undefined,
			);
		} else {
			const ids = normalizeConnectIds(runtime, rel.targetAccessor, del);
			await deleteInverseManyChildren(
				executor,
				runtime,
				rel,
				parentId,
				ids,
			);
		}
	}

	if ("disconnect" in value) {
		if (!fkCol.nullable) {
			compileError(
				`Cannot disconnect relation ${relationName}: FK column is not nullable`,
			);
		}
		await disconnectInverseMany(
			executor,
			runtime,
			rel,
			parentId,
			undefined,
		);
	}

	if ("set" in value) {
		const ids = normalizeConnectIds(
			runtime,
			rel.targetAccessor,
			value["set"],
		);
		const id = ids[0];
		if (id) {
			await disconnectInverseMany(
				executor,
				runtime,
				rel,
				parentId,
				undefined,
			);
			await connectInverseMany(executor, runtime, rel, parentId, [id]);
		}
		return;
	}

	if ("connect" in value) {
		const ids = normalizeConnectIds(
			runtime,
			rel.targetAccessor,
			value["connect"],
		);
		const id = ids[0];
		if (!id) return;
		if (ids.length > 1) {
			compileError(
				`Cannot connect more than one record to one-to-one relation ${relationName}`,
			);
		}
		await connectInverseMany(executor, runtime, rel, parentId, [id]);
	}

	if ("create" in value) {
		const items = normalizeCreateList(value["create"]);
		if (items.length > 1) {
			compileError(
				`Cannot create more than one record for one-to-one relation ${relationName}`,
			);
		}
		const item = items[0];
		if (item) {
			await runCreate(executor, runtime, rel.targetAccessor, {
				data: {
					...item,
					[rel.fkColumn]: parentId,
				},
			});
		}
	}
}

export async function executeRelationWrites(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	parentId: string,
	relationWrites: ParsedRelationWrite[],
	runCreate: CreateRunner,
): Promise<void> {
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");

	for (const write of relationWrites) {
		if (findM2M(manifest, tableAccessor, write.relationName)) {
			await executeM2MWrite(
				executor,
				runtime,
				tableAccessor,
				parentId,
				write.relationName,
				write.value,
			);
			continue;
		}

		const rel = findRelation(table, write.relationName);
		if (!rel) continue;

		if (rel.cardinality === "one") {
			if (!tableOwnsFkColumn(table, rel)) {
				await executeInverseOneWrite(
					executor,
					runtime,
					table,
					parentId,
					write.relationName,
					write.value,
					runCreate,
				);
			}
			continue;
		}

		await executeInverseManyWrite(
			executor,
			runtime,
			table,
			parentId,
			write.relationName,
			write.value,
			runCreate,
		);
	}
}

export function hasPostRelationWrites(
	table: ManifestTable,
	manifest: Manifest,
	tableAccessor: string,
	relationWrites: ParsedRelationWrite[],
): boolean {
	for (const write of relationWrites) {
		const rel = findRelation(table, write.relationName);
		if (rel?.cardinality === "many") return true;
		if (rel?.cardinality === "one" && !tableOwnsFkColumn(table, rel))
			return true;
		if (findM2M(manifest, tableAccessor, write.relationName)) return true;
	}
	return false;
}

export function relationWritesNeedTransaction(
	table: ManifestTable,
	manifest: Manifest,
	tableAccessor: string,
	relationWrites: ParsedRelationWrite[],
): boolean {
	if (relationWrites.length === 0) return false;
	if (hasPostRelationWrites(table, manifest, tableAccessor, relationWrites)) {
		return true;
	}
	for (const write of relationWrites) {
		const rel = findRelation(table, write.relationName);
		if (
			!rel ||
			rel.cardinality !== "one" ||
			!tableOwnsFkColumn(table, rel)
		) {
			continue;
		}
		if (
			typeof write.value === "object" &&
			write.value !== null &&
			"create" in write.value
		) {
			return true;
		}
	}
	return false;
}
