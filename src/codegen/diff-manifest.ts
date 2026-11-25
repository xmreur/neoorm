import { parseFkTarget } from "../dialect/fk.js";
import {
	canAutoCastType,
	DEFAULT_PG_SCHEMA,
	postgresDialect,
	resolveFkConstraintName,
	resolveIndexSqlName,
	resolveUniqueConstraintName,
} from "../dialect/postgres.js";
import { isMysqlFamilyDialect } from "../dialect/resolve.js";
import { manifestIndexKeys } from "../dialect/shared.js";
import type {
	ColumnAlter,
	DestructiveChange,
	DestructiveChangeKind,
	Dialect,
	FkChange,
	Manifest,
	ManifestColumn,
	ManifestDiff,
	ManifestForeignKey,
	ManifestIndex,
	ManifestTable,
	TableDiff,
} from "../dialect/types.js";

function tablesBySqlName(manifest: Manifest): Map<string, ManifestTable> {
	return new Map(
		Object.values(manifest.tables).map((table) => [table.sqlName, table]),
	);
}

export function columnSqlType(
	col: ManifestColumn,
	manifest?: Manifest,
	dialect: Dialect = postgresDialect,
): string {
	return dialect.columnType(col, manifest);
}

function isUnsafeTypeChange(
	alter: ColumnAlter,
	manifest?: Manifest,
	dialect: Dialect = postgresDialect,
): boolean {
	if (!alter.setType || alter.fromSqlType === undefined) {
		return false;
	}
	return !canAutoCastType(
		alter.fromSqlType,
		columnSqlType(alter.setType, manifest, dialect),
	);
}

function effectiveNullable(col: ManifestColumn): boolean {
	return col.primary ? false : col.nullable;
}

/** NOT NULL with nothing to fill existing rows. Serial columns generate values. */
function columnNeedsNotNullBackfill(col: ManifestColumn): boolean {
	if (effectiveNullable(col)) return false;
	if (col.kind === "serial") return false;
	if (col.defaultNow) return false;
	if (col.defaultValue !== undefined && col.defaultValue !== null) {
		return false;
	}
	return true;
}

export function isManualDestructiveChange(
	kind: DestructiveChangeKind,
): boolean {
	switch (kind) {
		case "alter_column_type_manual":
		case "alter_enum_manual":
		case "alter_primary_key":
		case "add_column_not_null":
		case "set_not_null":
			return true;
		case "drop_table":
		case "drop_column":
		case "alter_column_type":
		case "drop_index":
		case "drop_fk":
			return false;
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}

function primaryKeysEqual(
	prev: readonly string[],
	next: readonly string[],
): boolean {
	if (prev.length !== next.length) return false;
	return prev.every((name, index) => name === next[index]);
}

function onDeleteEqual(a: string | undefined, b: string | undefined): boolean {
	return (a ?? "no action") === (b ?? "no action");
}

function onUpdateEqual(a: string | undefined, b: string | undefined): boolean {
	return (a ?? "no action") === (b ?? "no action");
}

function deferrableEqual(
	a: string | undefined,
	b: string | undefined,
): boolean {
	return (a ?? "") === (b ?? "");
}

function isColumnUniqueIndex(
	table: ManifestTable,
	index: ManifestIndex,
): boolean {
	if (!index.unique || index.columns.length !== 1 || index.using) {
		return false;
	}
	if (index.keys?.some((key) => key.expr)) {
		return false;
	}
	const col = table.columns.find((c) => c.sqlName === index.columns[0]);
	return col?.unique === true;
}

function defaultsEqual(a: ManifestColumn, b: ManifestColumn): boolean {
	if (a.defaultNow !== b.defaultNow) return false;
	return JSON.stringify(a.defaultValue) === JSON.stringify(b.defaultValue);
}

function typeOptionsEqual(
	a?: Record<string, unknown>,
	b?: Record<string, unknown>,
): boolean {
	return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

export function columnsEqual(
	a: ManifestColumn,
	b: ManifestColumn,
	manifest?: Manifest,
	dialect: Dialect = postgresDialect,
): boolean {
	return (
		a.kind === b.kind &&
		effectiveNullable(a) === effectiveNullable(b) &&
		a.unique === b.unique &&
		a.primary === b.primary &&
		!!a.updatedAt === !!b.updatedAt &&
		defaultsEqual(a, b) &&
		typeOptionsEqual(a.typeOptions, b.typeOptions) &&
		a.checkExpression === b.checkExpression &&
		columnSqlType(a, manifest, dialect) ===
			columnSqlType(b, manifest, dialect) &&
		(a.kind !== "fk" ||
			(a.fkTarget === b.fkTarget &&
				onDeleteEqual(a.onDelete, b.onDelete) &&
				onUpdateEqual(a.onUpdate, b.onUpdate) &&
				deferrableEqual(a.deferrable, b.deferrable)))
	);
}

function isFkColumn(
	c: ManifestColumn,
): c is ManifestColumn & { fkTarget: string } {
	return c.kind === "fk" && c.fkTarget !== undefined;
}

function fkColumns(
	table: ManifestTable,
): Array<ManifestColumn & { fkTarget: string }> {
	return table.columns.filter(isFkColumn);
}

function orderTablesByForeignKeys(
	tables: ManifestTable[],
	mode: "parentsFirst" | "childrenFirst",
): ManifestTable[] {
	const bySql = new Map(tables.map((table) => [table.sqlName, table]));
	const visiting = new Set<string>();
	const done = new Set<string>();
	const ordered: ManifestTable[] = [];

	function visit(table: ManifestTable): void {
		if (done.has(table.sqlName)) return;
		if (visiting.has(table.sqlName)) return;
		visiting.add(table.sqlName);
		for (const col of fkColumns(table)) {
			const parent = bySql.get(parseFkTarget(col.fkTarget).tableSql);
			if (parent) visit(parent);
		}
		for (const fk of table.foreignKeys ?? []) {
			const parent = bySql.get(fk.targetTable);
			if (parent) visit(parent);
		}
		visiting.delete(table.sqlName);
		done.add(table.sqlName);
		ordered.push(table);
	}

	for (const table of tables) visit(table);
	return mode === "childrenFirst" ? ordered.reverse() : ordered;
}

function emitCreatedTablesSql(
	tables: ManifestTable[],
	dialect: Dialect,
	manifest?: Manifest,
): string[] {
	const isSqlite = dialect.name === "sqlite";
	const sql: string[] = [];
	tables = orderTablesByForeignKeys(tables, "parentsFirst");

	for (const table of tables) {
		sql.push(
			dialect.emitCreateTable(table, {
				inlineForeignKeys: isSqlite,
				...(manifest ? { manifest } : {}),
			}),
		);
		for (const index of table.indexes) {
			sql.push(dialect.emitCreateIndex(table, index, manifest));
		}
	}

	if (!isSqlite) {
		for (const table of tables) {
			for (const col of fkColumns(table)) {
				sql.push(dialect.emitAddForeignKey(table, col));
			}
			for (const fk of table.foreignKeys ?? []) {
				sql.push(dialect.emitAddTableForeignKey(table, fk));
			}
		}
	}

	return sql;
}

function indexSqlName(table: ManifestTable, index: ManifestIndex): string {
	return index.sqlName ?? resolveIndexSqlName(table.sqlName, index);
}

function indexKeySignature(index: ManifestIndex): string {
	return manifestIndexKeys(index)
		.map(
			(key) =>
				`${key.expr ? `e:${key.expr}` : (key.sqlName ?? "")}:${key.opclass ?? ""}`,
		)
		.join("|");
}

function indexWithSignature(index: ManifestIndex): string {
	const withOptions = index.with;
	if (!withOptions) return "";
	return `len:${withOptions.length ?? ""};cols:${(withOptions.cols ?? []).join(",")}`;
}

function indexesEqual(a: ManifestIndex, b: ManifestIndex): boolean {
	return (
		a.unique === b.unique &&
		(a.using ?? "btree") === (b.using ?? "btree") &&
		(a.opclass ?? "") === (b.opclass ?? "") &&
		indexWithSignature(a) === indexWithSignature(b) &&
		a.columns.length === b.columns.length &&
		a.columns.every((col, i) => col === b.columns[i]) &&
		indexKeySignature(a) === indexKeySignature(b) &&
		a.whereSql === b.whereSql
	);
}

function indexSignature(index: ManifestIndex): string {
	return `${index.unique ? "u" : "n"}:${index.using ?? "btree"}:${index.opclass ?? ""}:${indexWithSignature(index)}:${indexKeySignature(index)}:${index.whereSql ?? ""}`;
}

function diffIndexes(
	prevTable: ManifestTable,
	nextTable: ManifestTable,
): { addIndexes: ManifestIndex[]; dropIndexes: string[] } {
	const prevBySqlName = new Map(
		prevTable.indexes.map((idx) => [indexSqlName(prevTable, idx), idx]),
	);
	const nextBySqlName = new Map(
		nextTable.indexes.map((idx) => [indexSqlName(nextTable, idx), idx]),
	);

	const prevBySignature = new Map(
		prevTable.indexes.map((idx) => [indexSignature(idx), idx]),
	);
	const nextBySignature = new Map(
		nextTable.indexes.map((idx) => [indexSignature(idx), idx]),
	);

	const addIndexes: ManifestIndex[] = [];
	const dropIndexes: string[] = [];
	const matchedPrevSqlNames = new Set<string>();

	for (const [sqlName, nextIdx] of nextBySqlName) {
		const prevIdx = prevBySqlName.get(sqlName);
		if (prevIdx) {
			matchedPrevSqlNames.add(sqlName);
			if (!indexesEqual(prevIdx, nextIdx)) {
				dropIndexes.push(sqlName);
				addIndexes.push(nextIdx);
			}
			continue;
		}

		const prevBySig = prevBySignature.get(indexSignature(nextIdx));
		if (prevBySig) {
			matchedPrevSqlNames.add(indexSqlName(prevTable, prevBySig));
			if (!indexesEqual(prevBySig, nextIdx)) {
				dropIndexes.push(indexSqlName(prevTable, prevBySig));
				addIndexes.push(nextIdx);
			}
			continue;
		}

		addIndexes.push(nextIdx);
	}

	for (const [sqlName, prevIdx] of prevBySqlName) {
		if (matchedPrevSqlNames.has(sqlName)) continue;
		if (nextBySignature.has(indexSignature(prevIdx))) continue;
		if (isColumnUniqueIndex(nextTable, prevIdx)) continue;
		dropIndexes.push(sqlName);
	}

	return { addIndexes, dropIndexes };
}

function rewriteFkTarget(
	target: string,
	renamedSql: ReadonlyMap<string, string>,
): string {
	const { tableSql, columnSql } = parseFkTarget(target);
	const nextTable = renamedSql.get(tableSql);
	if (!nextTable) return target;
	return `${nextTable}.${columnSql}`;
}

function fkTargetsEqual(
	prev: string | undefined,
	next: string | undefined,
	renamedSql: ReadonlyMap<string, string>,
): boolean {
	if (prev === undefined || next === undefined) return prev === next;
	return rewriteFkTarget(prev, renamedSql) === next;
}

function diffForeignKeys(
	prevTable: ManifestTable,
	nextTable: ManifestTable,
	renamedSql: ReadonlyMap<string, string>,
): FkChange[] {
	const prevFks = new Map(fkColumns(prevTable).map((c) => [c.sqlName, c]));
	const nextFks = new Map(fkColumns(nextTable).map((c) => [c.sqlName, c]));
	const changes: FkChange[] = [];

	for (const [sqlName, nextCol] of nextFks) {
		const prevCol = prevFks.get(sqlName);
		if (!prevCol) {
			const add: FkChange["add"] = { target: nextCol.fkTarget };
			if (nextCol.onDelete !== undefined) {
				add.onDelete = nextCol.onDelete;
			}
			if (nextCol.onUpdate !== undefined) {
				add.onUpdate = nextCol.onUpdate;
			}
			if (nextCol.deferrable !== undefined) {
				add.deferrable = nextCol.deferrable;
			}
			if (nextCol.fkConstraintName !== undefined) {
				add.constraintName = nextCol.fkConstraintName;
			}
			changes.push({ column: sqlName, add });
			continue;
		}

		if (
			!fkTargetsEqual(prevCol.fkTarget, nextCol.fkTarget, renamedSql) ||
			!onDeleteEqual(prevCol.onDelete, nextCol.onDelete) ||
			!onUpdateEqual(prevCol.onUpdate, nextCol.onUpdate) ||
			!deferrableEqual(prevCol.deferrable, nextCol.deferrable)
		) {
			const add: NonNullable<FkChange["add"]> = {
				target: nextCol.fkTarget,
			};
			if (nextCol.onDelete !== undefined) {
				add.onDelete = nextCol.onDelete;
			}
			if (nextCol.onUpdate !== undefined) {
				add.onUpdate = nextCol.onUpdate;
			}
			if (nextCol.deferrable !== undefined) {
				add.deferrable = nextCol.deferrable;
			}
			if (nextCol.fkConstraintName !== undefined) {
				add.constraintName = nextCol.fkConstraintName;
			}
			changes.push({
				column: sqlName,
				drop:
					prevCol.fkConstraintName ??
					resolveFkConstraintName(prevTable.sqlName, sqlName),
				add,
			});
		}
	}

	for (const [sqlName, prevCol] of prevFks) {
		if (!nextFks.has(sqlName)) {
			changes.push({
				column: sqlName,
				drop:
					prevCol.fkConstraintName ??
					resolveFkConstraintName(prevTable.sqlName, sqlName),
			});
		}
	}

	changes.push(...diffCompositeForeignKeys(prevTable, nextTable, renamedSql));
	return changes;
}

function tableFkAdd(fk: ManifestForeignKey): NonNullable<FkChange["add"]> {
	const add: NonNullable<FkChange["add"]> = {
		target: fk.targetTable,
		targetColumns: fk.targetColumns,
		constraintName: fk.name,
	};
	if (fk.onDelete !== undefined) add.onDelete = fk.onDelete;
	if (fk.onUpdate !== undefined) add.onUpdate = fk.onUpdate;
	if (fk.deferrable !== undefined) add.deferrable = fk.deferrable;
	return add;
}

function compositeFksEqual(
	a: ManifestForeignKey,
	b: ManifestForeignKey,
	renamedSql: ReadonlyMap<string, string>,
): boolean {
	return (
		a.columns.length === b.columns.length &&
		a.columns.every((col, i) => col === b.columns[i]) &&
		(renamedSql.get(a.targetTable) ?? a.targetTable) === b.targetTable &&
		a.targetColumns.length === b.targetColumns.length &&
		a.targetColumns.every((col, i) => col === b.targetColumns[i]) &&
		onDeleteEqual(a.onDelete, b.onDelete) &&
		onUpdateEqual(a.onUpdate, b.onUpdate) &&
		deferrableEqual(a.deferrable, b.deferrable)
	);
}

function diffCompositeForeignKeys(
	prevTable: ManifestTable,
	nextTable: ManifestTable,
	renamedSql: ReadonlyMap<string, string>,
): FkChange[] {
	const prevByName = new Map(
		(prevTable.foreignKeys ?? []).map((fk) => [fk.name, fk]),
	);
	const nextByName = new Map(
		(nextTable.foreignKeys ?? []).map((fk) => [fk.name, fk]),
	);
	const changes: FkChange[] = [];

	for (const [name, nextFk] of nextByName) {
		const prevFk = prevByName.get(name);
		const firstCol = nextFk.columns[0] ?? name;
		if (!prevFk) {
			changes.push({
				column: firstCol,
				columns: nextFk.columns,
				add: tableFkAdd(nextFk),
			});
			continue;
		}
		if (!compositeFksEqual(prevFk, nextFk, renamedSql)) {
			changes.push({
				column: firstCol,
				columns: nextFk.columns,
				drop: prevFk.name,
				add: tableFkAdd(nextFk),
			});
		}
	}

	for (const [name, prevFk] of prevByName) {
		if (!nextByName.has(name)) {
			changes.push({
				column: prevFk.columns[0] ?? name,
				columns: prevFk.columns,
				drop: prevFk.name,
			});
		}
	}

	return changes;
}

function buildColumnAlter(
	prevCol: ManifestColumn,
	nextCol: ManifestColumn,
	prevTable: ManifestTable,
	alterSqlName: string,
	prevManifest?: Manifest,
	nextManifest?: Manifest,
	dialect: Dialect = postgresDialect,
): ColumnAlter | null {
	const alter: ColumnAlter = { sqlName: alterSqlName };
	let hasAlter = false;

	if (
		columnSqlType(prevCol, prevManifest, dialect) !==
		columnSqlType(nextCol, nextManifest, dialect)
	) {
		alter.setType = { ...nextCol, sqlName: alterSqlName };
		alter.fromSqlType = columnSqlType(prevCol, prevManifest, dialect);
		hasAlter = true;
	}

	if (effectiveNullable(prevCol) !== effectiveNullable(nextCol)) {
		alter.setNullable = effectiveNullable(nextCol);
		hasAlter = true;
	}

	if (!defaultsEqual(prevCol, nextCol)) {
		alter.setDefault =
			nextCol.defaultNow || nextCol.defaultValue !== undefined
				? { ...nextCol, sqlName: alterSqlName }
				: null;
		hasAlter = true;
	}

	if (prevCol.unique !== nextCol.unique) {
		if (prevCol.unique) {
			alter.dropUniqueConstraint =
				prevCol.uniqueConstraintName ??
				resolveUniqueConstraintName(prevTable.sqlName, prevCol.sqlName);
		}
		if (nextCol.unique) {
			alter.setUnique = true;
		}
		hasAlter = true;
	}

	if (prevCol.checkExpression !== nextCol.checkExpression) {
		if (prevCol.checkExpression) {
			alter.dropCheck = true;
		}
		alter.setCheckExpression = nextCol.checkExpression ?? null;
		hasAlter = true;
	}

	return hasAlter ? alter : null;
}

function diffColumns(
	prevTable: ManifestTable,
	nextTable: ManifestTable,
	prevManifest?: Manifest,
	nextManifest?: Manifest,
	dialect: Dialect = postgresDialect,
): {
	addColumns: ManifestColumn[];
	dropColumns: string[];
	renameColumns: Array<{ from: string; to: string }>;
	alterColumns: ColumnAlter[];
} {
	const prevByTs = new Map(prevTable.columns.map((c) => [c.tsName, c]));
	const nextByTs = new Map(nextTable.columns.map((c) => [c.tsName, c]));
	const prevBySql = new Map(prevTable.columns.map((c) => [c.sqlName, c]));
	const nextBySql = new Map(nextTable.columns.map((c) => [c.sqlName, c]));

	const renameColumns: Array<{ from: string; to: string }> = [];
	const renameFrom = new Set<string>();
	const renameTo = new Set<string>();

	for (const nextCol of nextTable.columns) {
		const prevCol = prevByTs.get(nextCol.tsName);
		if (prevCol && prevCol.sqlName !== nextCol.sqlName) {
			renameColumns.push({ from: prevCol.sqlName, to: nextCol.sqlName });
			renameFrom.add(prevCol.sqlName);
			renameTo.add(nextCol.sqlName);
		}
	}

	const addColumns: ManifestColumn[] = [];
	for (const nextCol of nextTable.columns) {
		if (renameTo.has(nextCol.sqlName)) continue;
		if (prevBySql.has(nextCol.sqlName)) continue;
		if (prevByTs.has(nextCol.tsName)) continue;
		addColumns.push(nextCol);
	}

	const dropColumns: string[] = [];
	for (const prevCol of prevTable.columns) {
		if (renameFrom.has(prevCol.sqlName)) continue;
		if (nextBySql.has(prevCol.sqlName)) continue;
		if (nextByTs.has(prevCol.tsName)) continue;
		dropColumns.push(prevCol.sqlName);
	}

	const alterColumns: ColumnAlter[] = [];
	for (const nextCol of nextTable.columns) {
		const prevCol = prevByTs.get(nextCol.tsName);
		if (!prevCol) continue;

		const alterSqlName =
			prevCol.sqlName !== nextCol.sqlName
				? nextCol.sqlName
				: prevCol.sqlName;
		const alter = buildColumnAlter(
			prevCol,
			nextCol,
			prevTable,
			alterSqlName,
			prevManifest,
			nextManifest,
			dialect,
		);
		if (alter) {
			alterColumns.push(alter);
		}
	}

	return { addColumns, dropColumns, renameColumns, alterColumns };
}

function diffTable(
	prevTable: ManifestTable | undefined,
	nextTable: ManifestTable | undefined,
	prevManifest?: Manifest,
	nextManifest?: Manifest,
	dialect: Dialect = postgresDialect,
	renamedSql: ReadonlyMap<string, string> = new Map(),
): TableDiff | null {
	if (!prevTable && nextTable) {
		return {
			table: nextTable,
			create: true,
			...(nextManifest ? { manifest: nextManifest } : {}),
		};
	}
	if (prevTable && !nextTable) {
		return {
			table: prevTable,
			drop: true,
			...(nextManifest ? { manifest: nextManifest } : {}),
		};
	}
	if (!prevTable || !nextTable) {
		return null;
	}

	const columnDiff = diffColumns(
		prevTable,
		nextTable,
		prevManifest,
		nextManifest,
		dialect,
	);
	const { addColumns, dropColumns, renameColumns, alterColumns } = columnDiff;
	const { addIndexes, dropIndexes } = diffIndexes(prevTable, nextTable);
	const fkChanges = diffForeignKeys(prevTable, nextTable, renamedSql);
	const primaryKeyChanged = !primaryKeysEqual(
		prevTable.primaryKey,
		nextTable.primaryKey,
	);

	const hasChanges =
		addColumns.length > 0 ||
		dropColumns.length > 0 ||
		renameColumns.length > 0 ||
		alterColumns.length > 0 ||
		addIndexes.length > 0 ||
		dropIndexes.length > 0 ||
		fkChanges.length > 0 ||
		primaryKeyChanged;

	if (!hasChanges) {
		return null;
	}

	return {
		table: nextTable,
		...(nextManifest ? { manifest: nextManifest } : {}),
		...(addColumns.length > 0 ? { addColumns } : {}),
		...(dropColumns.length > 0 ? { dropColumns } : {}),
		...(renameColumns.length > 0 ? { renameColumns } : {}),
		...(alterColumns.length > 0 ? { alterColumns } : {}),
		...(addIndexes.length > 0 ? { addIndexes } : {}),
		...(dropIndexes.length > 0 ? { dropIndexes } : {}),
		...(fkChanges.length > 0 ? { fkChanges } : {}),
	};
}

function enforcesNotNull(sql: string): boolean {
	if (sql.includes("DROP NOT NULL")) return false;
	return sql.includes("SET NOT NULL") || /\bNOT NULL\b/.test(sql);
}

function classifyDestructive(
	diff: TableDiff,
	prevTable?: ManifestTable,
	dialect: Dialect = postgresDialect,
): DestructiveChange[] {
	const changes: DestructiveChange[] = [];
	const tableName = diff.table.sqlName;
	const manifest = diff.manifest;

	if (diff.drop) {
		changes.push({
			kind: "drop_table",
			table: tableName,
			detail: `Drop table "${tableName}"`,
			sql: dialect.emitDropTable(diff.table),
		});
		return changes;
	}

	for (const col of diff.dropColumns ?? []) {
		changes.push({
			kind: "drop_column",
			table: tableName,
			detail: `Drop column "${tableName}"."${col}"`,
			sql: `ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP COLUMN ${dialect.quoteIdentifier(col)};`,
		});
	}

	if (
		prevTable &&
		!primaryKeysEqual(prevTable.primaryKey, diff.table.primaryKey)
	) {
		const from = prevTable.primaryKey.join(", ");
		const to = diff.table.primaryKey.join(", ");
		changes.push({
			kind: "alter_primary_key",
			table: tableName,
			detail: `Change primary key on "${tableName}" from (${from}) to (${to})`,
			sql: `-- primary key change on ${tableName} (${from} -> ${to}) requires manual migration`,
		});
	}

	for (const alter of diff.alterColumns ?? []) {
		if (alter.setType && isUnsafeTypeChange(alter, manifest, dialect)) {
			for (const sql of dialect.emitAlterColumn(
				diff.table,
				alter,
				manifest,
			)) {
				if (sql.includes(" TYPE ") || sql.includes("CREATE TABLE ")) {
					changes.push({
						kind: "alter_column_type_manual",
						table: tableName,
						detail: `Change type of "${tableName}"."${alter.sqlName}" (requires manual migration)`,
						sql,
					});
				}
			}
		}
	}

	for (const col of diff.addColumns ?? []) {
		if (!columnNeedsNotNullBackfill(col)) continue;
		const detail = `Add NOT NULL column "${tableName}"."${col.sqlName}" without a default`;
		for (const sql of dialect.emitAlterTable(diff.table, {
			table: diff.table,
			...(manifest ? { manifest } : {}),
			addColumns: [col],
		})) {
			changes.push({
				kind: "add_column_not_null",
				table: tableName,
				detail,
				sql,
			});
		}
	}

	const notNullAlters = (diff.alterColumns ?? []).filter(
		(alter) => alter.setNullable === false,
	);
	if (notNullAlters.length > 0) {
		const column = notNullAlters.map((alter) => alter.sqlName).join(", ");
		const detail = `Set "${tableName}"."${column}" NOT NULL without an UPDATE of existing nulls`;
		const statements =
			dialect.name === "sqlite"
				? dialect.emitAlterTable(diff.table, diff)
				: notNullAlters.flatMap((alter) =>
						dialect.emitAlterTable(diff.table, {
							table: diff.table,
							...(manifest ? { manifest } : {}),
							alterColumns: [alter],
						}),
					);
		for (const sql of statements) {
			if (dialect.name !== "sqlite" && !enforcesNotNull(sql)) continue;
			changes.push({
				kind: "set_not_null",
				table: tableName,
				detail,
				sql,
			});
		}
	}

	for (const indexName of diff.dropIndexes ?? []) {
		changes.push({
			kind: "drop_index",
			table: tableName,
			detail: `Drop index "${indexName}" on "${tableName}"`,
			sql: dialect.emitDropIndex(indexName),
		});
	}

	for (const change of diff.fkChanges ?? []) {
		if (change.drop) {
			changes.push({
				kind: "drop_fk",
				table: tableName,
				detail: `Drop foreign key on "${tableName}"."${change.column}"`,
				sql: dialect.emitDropConstraint(tableName, change.drop),
			});
		}
	}

	return changes;
}

function alterWithoutSetNotNull(
	alter: ColumnAlter,
	dialect: Dialect,
): ColumnAlter | null {
	if (alter.setNullable !== false) return alter;
	const next: ColumnAlter = { sqlName: alter.sqlName };
	if (alter.setType) next.setType = alter.setType;
	if (alter.fromSqlType !== undefined) next.fromSqlType = alter.fromSqlType;
	if (alter.setDefault !== undefined) next.setDefault = alter.setDefault;
	if (alter.setUnique !== undefined) next.setUnique = alter.setUnique;
	if (alter.dropUniqueConstraint !== undefined) {
		next.dropUniqueConstraint = alter.dropUniqueConstraint;
	}
	if (alter.setCheckExpression !== undefined) {
		next.setCheckExpression = alter.setCheckExpression;
	}
	if (alter.dropCheck !== undefined) next.dropCheck = alter.dropCheck;
	const hasWork =
		next.setType !== undefined ||
		next.setDefault !== undefined ||
		next.setUnique !== undefined ||
		next.dropUniqueConstraint !== undefined ||
		next.setCheckExpression !== undefined ||
		next.dropCheck !== undefined;
	if (!hasWork) return null;
	// MySQL MODIFY restates every attribute from the next column, which is
	// already NOT NULL. Force NULL so the safe statement does not set it.
	if (isMysqlFamilyDialect(dialect) && next.setType) {
		next.setNullable = true;
	}
	return next;
}

function safeAlterColumns(
	diff: TableDiff,
	dialect: Dialect,
): ColumnAlter[] | undefined {
	const alters = diff.alterColumns?.filter(
		(alter) =>
			!alter.setType ||
			!isUnsafeTypeChange(alter, diff.manifest, dialect),
	);
	if (!alters || alters.length === 0) return undefined;
	// SQLite rebuilds the whole table from the next definition, so a SET NOT
	// NULL cannot be peeled off of the other alters.
	if (
		dialect.name === "sqlite" &&
		alters.some((alter) => alter.setNullable === false)
	) {
		return undefined;
	}
	const kept = alters.flatMap((alter) => {
		const next = alterWithoutSetNotNull(alter, dialect);
		return next ? [next] : [];
	});
	return kept.length > 0 ? kept : undefined;
}

function stripDestructiveFromDiff(
	diff: TableDiff,
	dialect: Dialect = postgresDialect,
): TableDiff | null {
	if (diff.drop) {
		return null;
	}

	const fkChanges = diff.fkChanges?.filter((change) => !change.drop);
	const alterColumns = safeAlterColumns(diff, dialect);
	const addColumns = diff.addColumns?.filter(
		(col) => !columnNeedsNotNullBackfill(col),
	);

	const stripped: TableDiff = {
		table: diff.table,
		...(diff.renameFromSqlName
			? { renameFromSqlName: diff.renameFromSqlName }
			: {}),
		...(diff.create ? { create: diff.create } : {}),
		...(addColumns && addColumns.length > 0 ? { addColumns } : {}),
		...(diff.renameColumns && diff.renameColumns.length > 0
			? { renameColumns: diff.renameColumns }
			: {}),
		...(alterColumns && alterColumns.length > 0 ? { alterColumns } : {}),
		...(diff.addIndexes && diff.addIndexes.length > 0
			? { addIndexes: diff.addIndexes }
			: {}),
		...(fkChanges && fkChanges.length > 0 ? { fkChanges } : {}),
	};

	const hasChanges =
		stripped.create ||
		stripped.renameFromSqlName !== undefined ||
		(stripped.addColumns?.length ?? 0) > 0 ||
		(stripped.renameColumns?.length ?? 0) > 0 ||
		(stripped.alterColumns?.length ?? 0) > 0 ||
		(stripped.addIndexes?.length ?? 0) > 0 ||
		(stripped.fkChanges?.length ?? 0) > 0;

	return hasChanges ? stripped : null;
}

export function buildMigrationSql(
	tableDiffs: TableDiff[],
	extensions: string[] = [],
	manifest?: Manifest,
	newEnumTypes?: Record<string, { values: readonly string[] }>,
	dialect: Dialect = postgresDialect,
	enumDdl?: {
		addValues?: readonly EnumValueChange[];
		dropTypes?: readonly string[];
	},
): string[] {
	const sql: string[] = [];
	const schemaNames = new Set(
		Object.values(manifest?.tables ?? {})
			.map((table) => table.schemaName)
			.filter(
				(schema): schema is string =>
					schema !== undefined && schema !== DEFAULT_PG_SCHEMA,
			),
	);

	for (const schema of schemaNames) {
		const schemaSql = dialect.emitCreateSchema(schema);
		if (schemaSql) {
			sql.push(schemaSql);
		}
	}

	if (extensions.length > 0) {
		sql.push(...dialect.emitCreateExtensions(extensions));
	}

	if (newEnumTypes && Object.keys(newEnumTypes).length > 0) {
		sql.push(...dialect.emitCreateEnumTypes(newEnumTypes));
	}

	for (const added of enumDdl?.addValues ?? []) {
		const statement = dialect.emitAddEnumValue(added.name, added.value);
		if (statement) sql.push(statement);
	}

	const alterDiffs = tableDiffs.filter((d) => !d.create && !d.drop);
	const dropDiffs = tableDiffs.filter((d) => d.drop);
	const createDiffs = tableDiffs.filter((d) => d.create);

	for (const diff of alterDiffs) {
		sql.push(...dialect.emitAlterTable(diff.table, diff));
	}

	for (const table of orderTablesByForeignKeys(
		dropDiffs.map((diff) => diff.table),
		"childrenFirst",
	)) {
		sql.push(dialect.emitDropTable(table));
	}

	sql.push(
		...emitCreatedTablesSql(
			createDiffs.map((diff) => diff.table),
			dialect,
			manifest,
		),
	);

	for (const name of enumDdl?.dropTypes ?? []) {
		const statement = dialect.emitDropEnumType(name);
		if (statement) sql.push(statement);
	}

	return sql;
}

type EnumValueChange = {
	name: string;
	value: string;
};

type EnumTypeDiff = {
	newEnumTypes: Record<string, { values: readonly string[] }>;
	addValues: EnumValueChange[];
	dropTypes: string[];
	/** Native enum types whose value list was reordered or shortened. */
	manualNames: ReadonlySet<string>;
	destructive: DestructiveChange[];
};

function isEnumValueAppend(
	prev: readonly string[],
	next: readonly string[],
): boolean {
	if (next.length <= prev.length) return false;
	for (let index = 0; index < prev.length; index++) {
		if (prev[index] !== next[index]) return false;
	}
	return true;
}

function diffEnumTypes(prev: Manifest | null, next: Manifest): EnumTypeDiff {
	const destructive: DestructiveChange[] = [];
	const newEnumTypes: Record<string, { values: readonly string[] }> = {};
	const addValues: EnumValueChange[] = [];
	const dropTypes: string[] = [];
	const manualNames = new Set<string>();
	const prevEnums = prev?.enumTypes ?? {};
	const nextEnums = next.enumTypes ?? {};

	for (const [name, definition] of Object.entries(nextEnums)) {
		const prevDefinition = prevEnums[name];
		if (!prevDefinition) {
			newEnumTypes[name] = definition;
			continue;
		}
		if (
			JSON.stringify(prevDefinition.values) ===
			JSON.stringify(definition.values)
		) {
			continue;
		}
		if (isEnumValueAppend(prevDefinition.values, definition.values)) {
			for (const value of definition.values.slice(
				prevDefinition.values.length,
			)) {
				addValues.push({ name, value });
			}
			continue;
		}
		manualNames.add(name);
		destructive.push({
			kind: "alter_enum_manual",
			table: name,
			detail: `Enum type "${name}" values changed — manual migration required`,
			sql: `-- ALTER TYPE ${name} ... (manual)`,
		});
	}

	for (const name of Object.keys(prevEnums)) {
		if (!nextEnums[name]) dropTypes.push(name);
	}

	return { newEnumTypes, addValues, dropTypes, manualNames, destructive };
}

function nativeEnumName(column: ManifestColumn): string | undefined {
	const name = column.typeOptions?.nativeTypeName;
	return typeof name === "string" ? name : undefined;
}

function columnAlterHasWork(alter: ColumnAlter): boolean {
	return (
		alter.setType !== undefined ||
		alter.setNullable !== undefined ||
		alter.setDefault !== undefined ||
		alter.setUnique !== undefined ||
		alter.dropUniqueConstraint !== undefined ||
		alter.setCheckExpression !== undefined ||
		alter.dropCheck !== undefined
	);
}

function tableDiffHasSql(diff: TableDiff): boolean {
	return (
		diff.create === true ||
		diff.drop === true ||
		diff.renameFromSqlName !== undefined ||
		(diff.addColumns?.length ?? 0) > 0 ||
		(diff.dropColumns?.length ?? 0) > 0 ||
		(diff.renameColumns?.length ?? 0) > 0 ||
		(diff.alterColumns?.length ?? 0) > 0 ||
		(diff.addIndexes?.length ?? 0) > 0 ||
		(diff.dropIndexes?.length ?? 0) > 0 ||
		(diff.fkChanges?.length ?? 0) > 0
	);
}

/** MySQL ENUM reorder/delete is a MODIFY. Leave it out of the migration SQL. */
function stripManualEnumAlters(
	diffs: readonly TableDiff[],
	manualNames: ReadonlySet<string>,
): TableDiff[] {
	if (manualNames.size === 0) return [...diffs];
	const kept: TableDiff[] = [];
	for (const diff of diffs) {
		if (!diff.alterColumns) {
			kept.push(diff);
			continue;
		}
		const alterColumns = diff.alterColumns.flatMap((alter) => {
			const column = diff.table.columns.find(
				(candidate) => candidate.sqlName === alter.sqlName,
			);
			const enumName = column ? nativeEnumName(column) : undefined;
			if (
				enumName === undefined ||
				!manualNames.has(enumName) ||
				alter.setType === undefined
			) {
				return [alter];
			}
			const rest: ColumnAlter = { sqlName: alter.sqlName };
			if (alter.setNullable !== undefined)
				rest.setNullable = alter.setNullable;
			if (alter.setDefault !== undefined)
				rest.setDefault = alter.setDefault;
			if (alter.setUnique !== undefined) rest.setUnique = alter.setUnique;
			if (alter.dropUniqueConstraint !== undefined) {
				rest.dropUniqueConstraint = alter.dropUniqueConstraint;
			}
			if (alter.setCheckExpression !== undefined) {
				rest.setCheckExpression = alter.setCheckExpression;
			}
			if (alter.dropCheck !== undefined) rest.dropCheck = alter.dropCheck;
			return columnAlterHasWork(rest) ? [rest] : [];
		});
		const next: TableDiff = {
			table: diff.table,
			...(diff.manifest ? { manifest: diff.manifest } : {}),
			...(diff.create ? { create: diff.create } : {}),
			...(diff.drop ? { drop: diff.drop } : {}),
			...(diff.renameFromSqlName
				? { renameFromSqlName: diff.renameFromSqlName }
				: {}),
			...(diff.addColumns ? { addColumns: diff.addColumns } : {}),
			...(diff.dropColumns ? { dropColumns: diff.dropColumns } : {}),
			...(diff.renameColumns
				? { renameColumns: diff.renameColumns }
				: {}),
			...(alterColumns.length > 0 ? { alterColumns } : {}),
			...(diff.addIndexes ? { addIndexes: diff.addIndexes } : {}),
			...(diff.dropIndexes ? { dropIndexes: diff.dropIndexes } : {}),
			...(diff.fkChanges ? { fkChanges: diff.fkChanges } : {}),
		};
		if (tableDiffHasSql(next)) kept.push(next);
	}
	return kept;
}

function tableSqlKey(table: ManifestTable): string {
	return `${table.schemaName ?? ""}\0${table.sqlName}`;
}

/** Old SQL name → new SQL name for accessor renames that are unambiguous. */
function tableRenameSqlMap(
	prev: Manifest,
	next: Manifest,
): {
	byAccessor: Map<string, ManifestTable>;
	renamedSql: Map<string, string>;
} {
	const prevByKey = new Map<string, string>();
	const nextByKey = new Map<string, string>();
	for (const [accessor, table] of Object.entries(prev.tables)) {
		prevByKey.set(tableSqlKey(table), accessor);
	}
	for (const [accessor, table] of Object.entries(next.tables)) {
		nextByKey.set(tableSqlKey(table), accessor);
	}

	const byAccessor = new Map<string, ManifestTable>();
	for (const [accessor, nextTable] of Object.entries(next.tables)) {
		const prevTable = prev.tables[accessor];
		if (!prevTable) continue;
		if ((prevTable.schemaName ?? "") !== (nextTable.schemaName ?? "")) {
			continue;
		}
		if (prevTable.sqlName === nextTable.sqlName) continue;
		const prevOwnerOfNext = prevByKey.get(tableSqlKey(nextTable));
		if (prevOwnerOfNext !== undefined && prevOwnerOfNext !== accessor) {
			continue;
		}
		const nextOwnerOfPrev = nextByKey.get(tableSqlKey(prevTable));
		if (nextOwnerOfPrev !== undefined && nextOwnerOfPrev !== accessor) {
			continue;
		}
		byAccessor.set(accessor, prevTable);
	}

	const oldNameCount = new Map<string, number>();
	for (const prevTable of byAccessor.values()) {
		oldNameCount.set(
			prevTable.sqlName,
			(oldNameCount.get(prevTable.sqlName) ?? 0) + 1,
		);
	}
	const renamedSql = new Map<string, string>();
	for (const [accessor, prevTable] of byAccessor) {
		if ((oldNameCount.get(prevTable.sqlName) ?? 0) !== 1) continue;
		const nextTable = next.tables[accessor];
		if (!nextTable) continue;
		renamedSql.set(prevTable.sqlName, nextTable.sqlName);
	}
	return { byAccessor, renamedSql };
}

function diffManifestTables(
	prev: Manifest,
	next: Manifest,
	dialect: Dialect,
): TableDiff[] {
	const { byAccessor, renamedSql } = tableRenameSqlMap(prev, next);
	const consumedPrev = new Set<string>();
	const consumedNext = new Set<string>();
	const diffs: TableDiff[] = [];

	for (const [accessor, prevTable] of byAccessor) {
		const nextTable = next.tables[accessor];
		if (!nextTable) continue;
		consumedPrev.add(tableSqlKey(prevTable));
		consumedNext.add(tableSqlKey(nextTable));
		const diff = diffTable(
			prevTable,
			nextTable,
			prev,
			next,
			dialect,
			renamedSql,
		);
		diffs.push({
			...(diff ?? {
				table: nextTable,
				manifest: next,
			}),
			renameFromSqlName: prevTable.sqlName,
		});
	}

	const prevBySql = tablesBySqlName(prev);
	const nextBySql = tablesBySqlName(next);
	const allSqlNames = new Set([...prevBySql.keys(), ...nextBySql.keys()]);
	for (const sqlName of allSqlNames) {
		const prevTable = prevBySql.get(sqlName);
		const nextTable = nextBySql.get(sqlName);
		const prevForDiff =
			prevTable && consumedPrev.has(tableSqlKey(prevTable))
				? undefined
				: prevTable;
		const nextForDiff =
			nextTable && consumedNext.has(tableSqlKey(nextTable))
				? undefined
				: nextTable;
		if (!prevForDiff && !nextForDiff) continue;
		const diff = diffTable(
			prevForDiff,
			nextForDiff,
			prev,
			next,
			dialect,
			renamedSql,
		);
		if (diff) diffs.push(diff);
	}

	return diffs;
}

export function diffManifest(
	prev: Manifest | null,
	next: Manifest,
	dialect: Dialect = postgresDialect,
): ManifestDiff {
	if (!prev) {
		const sql: string[] = [];
		const schemaNames = new Set(
			Object.values(next.tables)
				.map((table) => table.schemaName)
				.filter(
					(schema): schema is string =>
						schema !== undefined && schema !== DEFAULT_PG_SCHEMA,
				),
		);
		for (const schema of schemaNames) {
			const schemaSql = dialect.emitCreateSchema(schema);
			if (schemaSql) {
				sql.push(schemaSql);
			}
		}
		const extensions = next.extensions ?? [];
		sql.push(...dialect.emitCreateExtensions(extensions));

		if (next.enumTypes) {
			sql.push(...dialect.emitCreateEnumTypes(next.enumTypes));
		}

		sql.push(
			...emitCreatedTablesSql(Object.values(next.tables), dialect, next),
		);

		return { isInitial: true, sql, destructive: [] };
	}

	const tableDiffs = diffManifestTables(prev, next, dialect);
	const destructive: DestructiveChange[] = [];

	const prevExtensions = new Set(prev.extensions ?? []);
	const newExtensions = (next.extensions ?? []).filter(
		(ext) => !prevExtensions.has(ext),
	);
	const enumDiff = diffEnumTypes(prev, next);
	const { newEnumTypes, destructive: enumDestructive } = enumDiff;
	const sqlDiffs = stripManualEnumAlters(tableDiffs, enumDiff.manualNames);

	for (const diff of tableDiffs) {
		const prevTable = diff.renameFromSqlName
			? Object.values(prev.tables).find(
					(table) =>
						table.accessor === diff.table.accessor &&
						table.sqlName === diff.renameFromSqlName,
				)
			: Object.values(prev.tables).find(
					(table) => table.sqlName === diff.table.sqlName,
				);
		destructive.push(...classifyDestructive(diff, prevTable, dialect));
	}

	destructive.push(...enumDestructive);

	const sql = buildMigrationSql(
		sqlDiffs,
		newExtensions,
		next,
		newEnumTypes,
		dialect,
		{
			addValues: enumDiff.addValues,
			dropTypes: enumDiff.dropTypes,
		},
	);

	return { isInitial: false, sql, destructive };
}

export function emptyManifest(): Manifest {
	return {
		version: 1,
		tables: {},
		manyToMany: [],
	};
}

/** SQL to roll back a forward migration (next → prev). */
export function buildDownSql(
	prev: Manifest | null,
	next: Manifest,
	dialect: Dialect = postgresDialect,
): string[] {
	const target = prev ?? emptyManifest();
	const diff = diffManifest(next, target, dialect);
	const { sql } = resolveMigrationSql(diff, next, target, true, dialect);
	return sql;
}

export function resolveMigrationSql(
	diff: ManifestDiff,
	prev: Manifest | null,
	next: Manifest,
	acceptDataLoss: boolean,
	dialect: Dialect = postgresDialect,
): { sql: string[]; blocked: DestructiveChange[] } {
	if (acceptDataLoss) {
		const blocked = diff.destructive.filter((change) =>
			isManualDestructiveChange(change.kind),
		);
		if (blocked.length === 0) {
			return { sql: diff.sql, blocked: [] };
		}
		const blockedSql = new Set(blocked.map((change) => change.sql));
		return {
			sql: diff.sql.filter((statement) => !blockedSql.has(statement)),
			blocked,
		};
	}

	if (diff.destructive.length === 0) {
		return { sql: diff.sql, blocked: [] };
	}

	if (!prev) {
		return { sql: diff.sql, blocked: [] };
	}

	const safeDiffs: TableDiff[] = [];
	for (const tableDiff of diffManifestTables(prev, next, dialect)) {
		const stripped = stripDestructiveFromDiff(tableDiff, dialect);
		if (stripped) {
			safeDiffs.push(stripped);
		}
	}

	const prevExtensions = new Set(prev.extensions ?? []);
	const newExtensions = (next.extensions ?? []).filter(
		(ext) => !prevExtensions.has(ext),
	);

	return {
		sql: buildMigrationSql(
			safeDiffs,
			newExtensions,
			next,
			undefined,
			dialect,
		),
		blocked: diff.destructive,
	};
}

function relationsSignature(manifest: Manifest): string {
	const parts: string[] = [];
	for (const table of Object.values(manifest.tables)) {
		for (const rel of table.relations) {
			parts.push(
				`${table.sqlName}:${rel.name}:${rel.inverse}:${rel.targetAccessor}`,
			);
		}
	}
	return parts.sort().join("|");
}

export function explainNoMigrationSql(
	prev: Manifest | null,
	next: Manifest,
	diff: ManifestDiff,
): string[] {
	const reasons: string[] = [];

	if (!prev) {
		return [
			"Initial schema — run generate again if no migration was expected.",
		];
	}

	for (const change of diff.destructive) {
		if (isManualDestructiveChange(change.kind)) {
			const [warning] = formatDestructiveWarnings([change]);
			if (warning) {
				reasons.push(warning);
			}
		}
	}

	if (prev.enumMode !== next.enumMode) {
		reasons.push(
			`enumMode changed (${prev.enumMode ?? "check"} → ${next.enumMode ?? "check"}) — no DDL emitted`,
		);
	}

	const prevExtensions = new Set(prev.extensions ?? []);
	const addedExtensions = (next.extensions ?? []).filter(
		(ext) => !prevExtensions.has(ext),
	);
	if (
		addedExtensions.length === 0 &&
		JSON.stringify(prev.extensions ?? []) !==
			JSON.stringify(next.extensions ?? [])
	) {
		reasons.push(
			"extensions metadata changed — no new CREATE EXTENSION statements",
		);
	}

	if (JSON.stringify(prev.manyToMany) !== JSON.stringify(next.manyToMany)) {
		reasons.push("manyToMany relation metadata changed — no DDL emitted");
	}

	if (relationsSignature(prev) !== relationsSignature(next)) {
		reasons.push("relation names or inverses changed — no DDL emitted");
	}

	if (diff.destructive.length > 0 && diff.sql.length === 0) {
		reasons.push(
			"Destructive changes detected; safe subset produced no SQL. Re-run with --accept-data-loss or write a manual migration.",
		);
	}

	if (reasons.length === 0) {
		reasons.push(
			"Manifest updated for codegen; database schema is already compatible.",
		);
	}

	return reasons;
}

export function formatDestructiveWarnings(
	destructive: DestructiveChange[],
): string[] {
	return destructive.map((change) => {
		switch (change.kind) {
			case "drop_table":
				return `${change.detail} — this may cause irreversible data loss`;
			case "drop_column":
				return `${change.detail} — this may cause irreversible data loss`;
			case "alter_column_type":
				return `${change.detail} — this may fail or truncate existing data`;
			case "alter_column_type_manual":
				return `${change.detail} — add a manual migration with an explicit USING expression`;
			case "drop_index":
				return `${change.detail} — this may affect query performance`;
			case "drop_fk":
				return `${change.detail} — this may affect referential integrity`;
			case "alter_primary_key":
				return `${change.detail} — primary key changes require manual migration`;
			case "alter_enum_manual":
				return `${change.detail} — removing or reordering enum values requires a manual migration`;
			case "add_column_not_null":
				return `${change.detail} — add a default, or write a manual migration that backfills existing rows`;
			case "set_not_null":
				return `${change.detail} — write a manual migration that UPDATEs existing nulls before SET NOT NULL`;
			default: {
				const _exhaustive: never = change.kind;
				return _exhaustive;
			}
		}
	});
}
