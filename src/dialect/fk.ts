import { schemaError } from "../runtime/error-builders.js";
import { SchemaErrorCode } from "../runtime/error-codes.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestForeignKey,
	ManifestRelation,
	ManifestTable,
} from "./types.js";

export type FkTargetParts = {
	tableSql: string;
	columnSql: string;
};

export function parseFkTarget(target: string): FkTargetParts {
	const dotIndex = target.indexOf(".");
	if (dotIndex <= 0 || dotIndex === target.length - 1) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			`Invalid foreign key target "${target}"`,
		);
	}
	const tableSql = target.slice(0, dotIndex);
	const columnSql = target.slice(dotIndex + 1);
	if (!tableSql || !columnSql) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			`Invalid foreign key target "${target}"`,
		);
	}
	return { tableSql, columnSql };
}

function findTableBySqlName(
	manifest: Manifest,
	tableSql: string,
): ManifestTable | undefined {
	return Object.values(manifest.tables).find(
		(table) => table.sqlName === tableSql,
	);
}

function findColumnByFkRef(
	table: ManifestTable,
	columnRef: string,
): ManifestColumn | undefined {
	return (
		table.columns.find((column) => column.sqlName === columnRef) ??
		table.columns.find((column) => column.tsName === columnRef)
	);
}

export function findFkReferencedColumn(
	col: ManifestColumn,
	manifest: Manifest,
): ManifestColumn | undefined {
	if (col.kind !== "fk" || !col.fkTarget) return undefined;

	const seen = new Set<string>();
	let current: ManifestColumn | undefined = col;

	while (current?.kind === "fk" && current.fkTarget) {
		if (seen.has(current.fkTarget)) return undefined;
		seen.add(current.fkTarget);

		const { tableSql, columnSql } = parseFkTarget(current.fkTarget);
		const targetTable = findTableBySqlName(manifest, tableSql);
		if (!targetTable) return undefined;

		const next = findColumnByFkRef(targetTable, columnSql);
		if (!next) return undefined;
		current = next;
	}

	return current;
}

export type FkReferentialOptions = {
	onDelete?: string | undefined;
	onUpdate?: string | undefined;
	deferrable?: string | undefined;
};

/** `ON DELETE` / `ON UPDATE` / `DEFERRABLE` suffix for a FOREIGN KEY clause. */
export function fkReferentialSuffix(opts: FkReferentialOptions): string {
	let sql = "";
	if (opts.onDelete) {
		sql += ` ON DELETE ${opts.onDelete.toUpperCase()}`;
	}
	if (opts.onUpdate) {
		sql += ` ON UPDATE ${opts.onUpdate.toUpperCase()}`;
	}
	if (opts.deferrable === "deferred") {
		sql += " DEFERRABLE INITIALLY DEFERRED";
	} else if (opts.deferrable === "immediate") {
		sql += " DEFERRABLE INITIALLY IMMEDIATE";
	}
	return sql;
}

export function formatForeignKeyClause(
	quote: (id: string) => string,
	columns: readonly string[],
	targetTableRef: string,
	targetColumns: readonly string[],
	opts: FkReferentialOptions,
): string {
	const cols = columns.map((col) => quote(col)).join(", ");
	const refs = targetColumns.map((col) => quote(col)).join(", ");
	return `FOREIGN KEY (${cols}) REFERENCES ${targetTableRef}(${refs})${fkReferentialSuffix(opts)}`;
}

export function columnFkClause(
	quote: (id: string) => string,
	col: ManifestColumn,
	targetTableRef: string,
	targetCol: string,
): string {
	return formatForeignKeyClause(
		quote,
		[col.sqlName],
		targetTableRef,
		[targetCol],
		{
			...(col.onDelete ? { onDelete: col.onDelete } : {}),
			...(col.onUpdate ? { onUpdate: col.onUpdate } : {}),
			...(col.deferrable ? { deferrable: col.deferrable } : {}),
		},
	);
}

export function tableForeignKeyClause(
	quote: (id: string) => string,
	fk: ManifestForeignKey,
	targetTableRef: string,
): string {
	return formatForeignKeyClause(
		quote,
		fk.columns,
		targetTableRef,
		fk.targetColumns,
		fk,
	);
}

export type RelationFkPair = {
	fkColumn: string;
	fkSqlColumn: string;
	targetColumn: string;
};

export function relationFkPairs(rel: ManifestRelation): RelationFkPair[] {
	const fkColumns = rel.fkColumns ?? [rel.fkColumn];
	const fkSqlColumns = rel.fkSqlColumns ?? [rel.fkSqlColumn];
	const targetColumns = rel.targetColumns ?? [rel.targetColumn];
	return fkColumns.map((fkColumn, i) => ({
		fkColumn,
		fkSqlColumn: fkSqlColumns[i] ?? rel.fkSqlColumn,
		targetColumn: targetColumns[i] ?? rel.targetColumn,
	}));
}

export function relationReferencedSqlColumns(
	rel: ManifestRelation,
	parentPkSql?: string,
): readonly string[] {
	if (rel.referencedSqlColumns && rel.referencedSqlColumns.length > 0) {
		return rel.referencedSqlColumns;
	}
	if (rel.targetColumns && rel.targetColumns.length > 0) {
		return rel.targetColumns;
	}
	if (rel.targetColumn) {
		return [rel.targetColumn];
	}
	return parentPkSql ? [parentPkSql] : [];
}

export function emitFkChangeAdd(
	table: ManifestTable,
	change: {
		column: string;
		columns?: readonly string[];
		add?: {
			target: string;
			targetColumns?: readonly string[];
			onDelete?: string;
			onUpdate?: string;
			deferrable?: string;
			constraintName?: string;
		};
	},
	emitColumn: (col: ManifestColumn) => string,
	emitTableFk: (fk: ManifestForeignKey) => string,
): string | undefined {
	if (!change.add) return undefined;
	const columns = change.columns ?? [change.column];
	if (columns.length > 1) {
		let tableSql: string;
		let targetColumns: readonly string[];
		if (change.add.target.includes(".")) {
			const parsed = parseFkTarget(change.add.target);
			tableSql = parsed.tableSql;
			targetColumns = change.add.targetColumns ?? [parsed.columnSql];
		} else {
			tableSql = change.add.target;
			targetColumns = change.add.targetColumns ?? [];
		}
		return emitTableFk({
			name:
				change.add.constraintName ??
				`${table.sqlName}_${columns.join("_")}_fkey`,
			columns,
			targetTable: tableSql,
			targetColumns,
			...(change.add.onDelete ? { onDelete: change.add.onDelete } : {}),
			...(change.add.onUpdate ? { onUpdate: change.add.onUpdate } : {}),
			...(change.add.deferrable
				? { deferrable: change.add.deferrable }
				: {}),
		});
	}
	const col = table.columns.find((c) => c.sqlName === change.column);
	if (!col && !change.add.target) return undefined;
	const fkCol: ManifestColumn = {
		...(col ?? {
			tsName: change.column,
			sqlName: change.column,
			kind: "fk",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		}),
		kind: "fk",
		fkTarget: change.add.target,
	};
	if (change.add.onDelete !== undefined) {
		fkCol.onDelete = change.add.onDelete;
	}
	if (change.add.onUpdate !== undefined) {
		fkCol.onUpdate = change.add.onUpdate;
	}
	if (change.add.deferrable !== undefined) {
		fkCol.deferrable = change.add.deferrable;
	}
	if (change.add.constraintName !== undefined) {
		fkCol.fkConstraintName = change.add.constraintName;
	}
	return emitColumn(fkCol);
}
