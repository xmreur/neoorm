import {
	canAutoCastType,
	DEFAULT_PG_SCHEMA,
	postgresDialect,
	resolveFkConstraintName,
	resolveIndexSqlName,
	resolveUniqueConstraintName,
} from "../dialect/postgres.js";
import type {
	ColumnAlter,
	DestructiveChange,
	Dialect,
	FkChange,
	Manifest,
	ManifestColumn,
	ManifestDiff,
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

function onDeleteEqual(a: string | undefined, b: string | undefined): boolean {
	return (a ?? "no action") === (b ?? "no action");
}

function isColumnUniqueIndex(
	table: ManifestTable,
	index: ManifestIndex,
): boolean {
	if (!index.unique || index.columns.length !== 1) {
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
			(a.fkTarget === b.fkTarget && onDeleteEqual(a.onDelete, b.onDelete)))
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

function indexSqlName(table: ManifestTable, index: ManifestIndex): string {
	return index.sqlName ?? resolveIndexSqlName(table.sqlName, index);
}

function indexesEqual(a: ManifestIndex, b: ManifestIndex): boolean {
	return (
		a.unique === b.unique &&
		a.columns.length === b.columns.length &&
		a.columns.every((col, i) => col === b.columns[i])
	);
}

function indexSignature(index: ManifestIndex): string {
	return `${index.unique ? "u" : "n"}:${index.columns.join(",")}`;
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

function diffForeignKeys(
	prevTable: ManifestTable,
	nextTable: ManifestTable,
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
			if (nextCol.fkConstraintName !== undefined) {
				add.constraintName = nextCol.fkConstraintName;
			}
			changes.push({ column: sqlName, add });
			continue;
		}

		if (
			prevCol.fkTarget !== nextCol.fkTarget ||
			!onDeleteEqual(prevCol.onDelete, nextCol.onDelete)
		) {
			const add: NonNullable<FkChange["add"]> = {
				target: nextCol.fkTarget,
			};
			if (nextCol.onDelete !== undefined) {
				add.onDelete = nextCol.onDelete;
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

	if (prevCol.primary !== nextCol.primary) {
		hasAlter = true;
	}

	if (prevCol.checkExpression !== nextCol.checkExpression) {
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
	const fkChanges = diffForeignKeys(prevTable, nextTable);

	const hasChanges =
		addColumns.length > 0 ||
		dropColumns.length > 0 ||
		renameColumns.length > 0 ||
		alterColumns.length > 0 ||
		addIndexes.length > 0 ||
		dropIndexes.length > 0 ||
		fkChanges.length > 0;

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

		if (prevTable) {
			const prevCol = prevTable.columns.find(
				(c) =>
					c.sqlName === alter.sqlName ||
					c.tsName ===
						diff.table.columns.find(
							(n) => n.sqlName === alter.sqlName,
						)?.tsName,
			);
			const nextCol = diff.table.columns.find(
				(c) => c.sqlName === alter.sqlName,
			);
			if (prevCol && nextCol && prevCol.primary !== nextCol.primary) {
				changes.push({
					kind: "alter_primary_key",
					table: tableName,
					detail: `Change primary key on "${tableName}"."${alter.sqlName}"`,
					sql: `-- primary key change on ${tableName}.${alter.sqlName} requires manual migration`,
				});
			}
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

function stripDestructiveFromDiff(
	diff: TableDiff,
	dialect: Dialect = postgresDialect,
): TableDiff | null {
	if (diff.drop) {
		return null;
	}

	const fkChanges = diff.fkChanges?.filter((change) => !change.drop);
	const alterColumns = diff.alterColumns?.filter(
		(alter) =>
			!alter.setType || !isUnsafeTypeChange(alter, diff.manifest, dialect),
	);

	const stripped: TableDiff = {
		table: diff.table,
		...(diff.create ? { create: diff.create } : {}),
		...(diff.addColumns && diff.addColumns.length > 0
			? { addColumns: diff.addColumns }
			: {}),
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
): string[] {
	const sql: string[] = [];
	const isSqlite = dialect.name === "sqlite";
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

	const alterDiffs = tableDiffs.filter((d) => !d.create && !d.drop);
	const dropDiffs = tableDiffs.filter((d) => d.drop);
	const createDiffs = tableDiffs.filter((d) => d.create);

	for (const diff of alterDiffs) {
		sql.push(...dialect.emitAlterTable(diff.table, diff));
	}

	for (const diff of dropDiffs) {
		sql.push(dialect.emitDropTable(diff.table));
	}

	for (const diff of createDiffs) {
		sql.push(
			dialect.emitCreateTable(diff.table, {
				inlineForeignKeys: isSqlite,
				...(manifest ? { manifest } : {}),
			}),
		);
		for (const index of diff.table.indexes) {
			if (!index.unique) {
				sql.push(dialect.emitCreateIndex(diff.table, index));
			}
		}
		if (!isSqlite) {
			for (const col of fkColumns(diff.table)) {
				sql.push(dialect.emitAddForeignKey(diff.table, col));
			}
		}
	}

	return sql;
}

function diffEnumTypes(
	prev: Manifest | null,
	next: Manifest,
): {
	newEnumTypes: Record<string, { values: readonly string[] }>;
	destructive: DestructiveChange[];
} {
	const destructive: DestructiveChange[] = [];
	const newEnumTypes: Record<string, { values: readonly string[] }> = {};
	const prevEnums = prev?.enumTypes ?? {};
	const nextEnums = next.enumTypes ?? {};

	for (const [name, definition] of Object.entries(nextEnums)) {
		const prevDefinition = prevEnums[name];
		if (!prevDefinition) {
			newEnumTypes[name] = definition;
			continue;
		}
		if (
			JSON.stringify(prevDefinition.values) !==
			JSON.stringify(definition.values)
		) {
			destructive.push({
				kind: "alter_enum_manual",
				table: name,
				detail: `Enum type "${name}" values changed — manual migration required`,
				sql: `-- ALTER TYPE ${name} ... (manual)`,
			});
		}
	}

	return { newEnumTypes, destructive };
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

		const tables = Object.values(next.tables);
		for (const table of tables) {
			sql.push(
				dialect.emitCreateTable(table, { manifest: next }),
			);
			for (const index of table.indexes) {
				if (!index.unique) {
					sql.push(dialect.emitCreateIndex(table, index));
				}
			}
		}

		return { isInitial: true, sql, destructive: [] };
	}

	const prevBySql = tablesBySqlName(prev);
	const nextBySql = tablesBySqlName(next);
	const allSqlNames = new Set([...prevBySql.keys(), ...nextBySql.keys()]);

	const tableDiffs: TableDiff[] = [];
	const destructive: DestructiveChange[] = [];

	const prevExtensions = new Set(prev.extensions ?? []);
	const newExtensions = (next.extensions ?? []).filter(
		(ext) => !prevExtensions.has(ext),
	);
	const { newEnumTypes, destructive: enumDestructive } = diffEnumTypes(
		prev,
		next,
	);

	for (const sqlName of allSqlNames) {
		const prevTable = prevBySql.get(sqlName);
		const nextTable = nextBySql.get(sqlName);
		const diff = diffTable(prevTable, nextTable, prev, next, dialect);
		if (!diff) continue;
		tableDiffs.push(diff);
		destructive.push(...classifyDestructive(diff, prevTable, dialect));
	}

	destructive.push(...enumDestructive);

	const sql = buildMigrationSql(
		tableDiffs,
		newExtensions,
		next,
		newEnumTypes,
		dialect,
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
		const blocked = diff.destructive.filter(
			(change) =>
				change.kind === "alter_column_type_manual" ||
				change.kind === "alter_enum_manual",
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

	const prevBySql = tablesBySqlName(prev);
	const nextBySql = tablesBySqlName(next);
	const allSqlNames = new Set([...prevBySql.keys(), ...nextBySql.keys()]);

	const safeDiffs: TableDiff[] = [];
	for (const sqlName of allSqlNames) {
		const prevTable = prevBySql.get(sqlName);
		const nextTable = nextBySql.get(sqlName);
		const tableDiff = diffTable(prevTable, nextTable, prev, next, dialect);
		if (!tableDiff) continue;
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
		sql: buildMigrationSql(safeDiffs, newExtensions, next, undefined, dialect),
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
		if (
			change.kind === "alter_column_type_manual" ||
			change.kind === "alter_enum_manual"
		) {
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
				return `${change.detail} — enum value changes require manual migration`;
			default: {
				const _exhaustive: never = change.kind;
				return _exhaustive;
			}
		}
	});
}
