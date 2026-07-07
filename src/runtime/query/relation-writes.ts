import { quoteIdentifier, tableRef } from "../../dialect/postgres.js";
import type {
	Manifest,
	ManifestManyToMany,
	ManifestRelation,
	ManifestTable,
} from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import { buildInsertQuery, dataToSqlValues } from "./compile.js";
import { type QueryRuntime, runQuery, runQueryOne } from "./execute.js";
import type { WithInput } from "./find.js";
import { findOrCreatePk } from "./find-or-create.js";
import {
	findM2M,
	findRelation,
	tableOwnsFkColumn,
} from "./manifest-lookup.js";
import {
	fillMissingPrimaryKeys,
	primaryKeySqlName,
	rowScalarPkValue,
	targetRelationPkSql,
} from "./primary-key.js";

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

function isRelationWriteObject(
	value: unknown,
): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return false;
	return RELATION_WRITE_KEYS.some((key) => key in value);
}

function isRelationField(
	manifest: Manifest,
	tableAccessor: string,
	table: ManifestTable,
	key: string,
): boolean {
	if (findRelation(table, key)) return true;
	return findM2M(manifest, tableAccessor, key) !== undefined;
}

function normalizeIdList(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value
			.map((item) => (item as { id?: string }).id)
			.filter((id): id is string => id != null);
	}
	if (typeof value === "object" && "id" in value) {
		const id = (value as { id?: string }).id;
		return id != null ? [id] : [];
	}
	return [];
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
): SplitDataResult {
	const scalarData: Record<string, unknown> = {};
	const relationWrites: ParsedRelationWrite[] = [];

	for (const [key, value] of Object.entries(data)) {
		const col = table.columns.find((c) => c.tsName === key);
		if (col) {
			scalarData[key] = value;
			continue;
		}

		if (
			isRelationField(manifest, tableAccessor, table, key) &&
			isRelationWriteObject(value)
		) {
			relationWrites.push({ relationName: key, value });
		}
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
		const id = await findOrCreatePk(executor, runtime, targetAccessor, item);
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
	const { manifest } = runtime;
	const throughTable = manifest.tables[m2m.throughAccessor];
	if (!throughTable) return;

	const isLeft = m2m.leftAccessor === parentAccessor;
	const leftCol = throughTable.columns.find(
		(c) => c.sqlName === (isLeft ? m2m.leftFkColumn : m2m.rightFkColumn),
	);
	const rightCol = throughTable.columns.find(
		(c) => c.sqlName === (isLeft ? m2m.rightFkColumn : m2m.leftFkColumn),
	);
	if (!leftCol || !rightCol) return;

	for (const otherId of otherIds) {
		const leftId = isLeft ? parentId : otherId;
		const rightId = isLeft ? otherId : parentId;

		const existing = await runQueryOne(
			executor,
			runtime,
			{ operation: "select", tableAccessor: throughTable.accessor },
			`SELECT 1 FROM ${tableRef(throughTable)} WHERE ${quoteIdentifier(leftCol.sqlName)} = $1 AND ${quoteIdentifier(rightCol.sqlName)} = $2 LIMIT 1`,
			[leftId, rightId],
		);
		if (existing) continue;

		const data: Record<string, unknown> = {
			[leftCol.tsName]: leftId,
			[rightCol.tsName]: rightId,
		};

		for (const col of throughTable.columns) {
			if (col.tsName in data) continue;
			if (col.defaultNow) {
				data[col.tsName] = new Date();
			}
		}

		fillMissingPrimaryKeys(throughTable, data);

		const { keys, values } = dataToSqlValues(throughTable, data);
		const sql = buildInsertQuery(throughTable, keys);
		await runQuery(
			executor,
			runtime,
			{ operation: "insert", tableAccessor: throughTable.accessor },
			sql,
			values,
		);
	}
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
		throw new Error(`Unknown junction table: ${throughAccessor}`);
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

	const isLeft = m2m.leftAccessor === parentAccessor;
	const parentFkCol = isLeft ? m2m.leftFkColumn : m2m.rightFkColumn;
	const otherFkCol = isLeft ? m2m.rightFkColumn : m2m.leftFkColumn;

	const parentCol = throughTable.columns.find(
		(c) => c.sqlName === parentFkCol,
	);
	const otherCol = throughTable.columns.find((c) => c.sqlName === otherFkCol);
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
) {
	const col =
		targetTable.columns.find((c) => c.tsName === relation.fkColumn) ??
		targetTable.columns.find((c) => c.sqlName === relation.fkSqlColumn);
	if (!col) {
		throw new Error(`FK column not found for relation ${relation.name}`);
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

	const fkCol = childFkColumnMeta(targetTable, relation);
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

	const fkCol = childFkColumnMeta(targetTable, relation);
	if (!fkCol.nullable) {
		throw new Error(
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

	const fkCol = childFkColumnMeta(targetTable, relation);
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

	const isLeft = m2m.leftAccessor === parentAccessor;
	const parentFkCol = isLeft ? m2m.leftFkColumn : m2m.rightFkColumn;
	const otherFkCol = isLeft ? m2m.rightFkColumn : m2m.leftFkColumn;

	const parentCol = throughTable.columns.find(
		(c) => c.sqlName === parentFkCol,
	);
	const otherCol = throughTable.columns.find((c) => c.sqlName === otherFkCol);
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
	const rel = findRelation(table, relationName);
	if (!rel || rel.cardinality !== "one") return;

	if ("connect" in value) {
		const connect = value["connect"] as { id: string };
		scalarData[rel.fkColumn] = connect.id;
		return;
	}

	if ("disconnect" in value) {
		const fkCol = table.columns.find(
			(c) => c.tsName === rel.fkColumn || c.sqlName === rel.fkSqlColumn,
		);
		if (fkCol && !fkCol.nullable) {
			throw new Error(
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
		if (!targetTable)
			throw new Error(`Unknown table: ${rel.targetAccessor}`);
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
			const ids = normalizeIdList(del);
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
			const ids = normalizeIdList(disconnect);
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
		const ids = normalizeIdList(value["set"]);
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
		const ids = normalizeIdList(value["connect"]);
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
			const ids = normalizeIdList(del);
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
			const ids = normalizeIdList(disconnect);
			await disconnectInverseMany(executor, runtime, rel, parentId, ids);
		}
	}

	if ("set" in value) {
		const ids = normalizeIdList(value["set"]);
		await setInverseMany(executor, runtime, rel, parentId, ids);
		return;
	}

	if ("connect" in value) {
		const ids = normalizeIdList(value["connect"]);
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
			const ids = normalizeIdList(del);
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
			throw new Error(
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
		const ids = normalizeIdList(value["set"]);
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
		const ids = normalizeIdList(value["connect"]);
		const id = ids[0];
		if (!id) return;
		if (ids.length > 1) {
			throw new Error(
				`Cannot connect more than one record to one-to-one relation ${relationName}`,
			);
		}
		await connectInverseMany(executor, runtime, rel, parentId, [id]);
	}

	if ("create" in value) {
		const items = normalizeCreateList(value["create"]);
		if (items.length > 1) {
			throw new Error(
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
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

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
