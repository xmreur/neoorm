import type {
	ManifestColumn,
	ManifestIndex,
	ManifestIndexKey,
	ManifestTable,
} from "./types.js";

export function quoteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

export function quoteQualifiedIdentifier(
	schema: string | undefined,
	name: string,
): string {
	const resolved = schema ?? "public";
	return `${quoteIdentifier(resolved)}.${quoteIdentifier(name)}`;
}

export function tableRef(table: ManifestTable): string {
	return table.schemaName && table.schemaName !== "public"
		? quoteQualifiedIdentifier(table.schemaName, table.sqlName)
		: quoteIdentifier(table.sqlName);
}

export function defaultTableRef(table: ManifestTable): string {
	return quoteIdentifier(table.sqlName);
}

/** Column-level `PRIMARY KEY` is valid only for a single-column key. */
export function isSolePrimaryKeyColumn(
	col: ManifestColumn,
	table: ManifestTable,
): boolean {
	return table.primaryKey.length === 1 && table.primaryKey[0] === col.sqlName;
}

export function manifestIndexKeys(
	index: ManifestIndex,
): readonly ManifestIndexKey[] {
	if (index.keys && index.keys.length > 0) {
		return index.keys;
	}
	return index.columns.map((sqlName) => ({ sqlName }));
}

export function indexHasExpressionKey(index: ManifestIndex): boolean {
	return manifestIndexKeys(index).some((key) => Boolean(key.expr));
}

export function indexUsingClause(index: ManifestIndex): string {
	if (!index.using || index.using === "btree") {
		return "";
	}
	return ` USING ${index.using}`;
}

/**
 * `WITH (...)` storage options for `USING bloom` indexes.
 * `cols` maps positionally to the index keys (`col1`, `col2`, …).
 */
export function indexWithClause(index: ManifestIndex): string {
	if (index.using !== "bloom" || !index.with) {
		return "";
	}
	const parts: string[] = [];
	if (index.with.length !== undefined) {
		parts.push(`length = ${index.with.length}`);
	}
	for (let i = 0; i < (index.with.cols ?? []).length; i++) {
		parts.push(`col${i + 1} = ${index.with.cols?.[i]}`);
	}
	return parts.length > 0 ? ` WITH (${parts.join(", ")})` : "";
}

export function formatIndexKeyList(
	index: ManifestIndex,
	quote: (ident: string) => string,
	options: {
		formatIdent?: (sqlName: string) => string;
		wrapExpr?: (expr: string) => string;
	} = {},
): string {
	return manifestIndexKeys(index)
		.map((key) => {
			const opclass = key.opclass ?? index.opclass;
			let piece: string;
			if (key.expr) {
				piece = options.wrapExpr
					? options.wrapExpr(key.expr)
					: key.expr;
			} else if (key.sqlName) {
				piece = options.formatIdent
					? options.formatIdent(key.sqlName)
					: quote(key.sqlName);
			} else {
				piece = quote(index.name);
			}
			return opclass ? `${piece} ${opclass}` : piece;
		})
		.join(", ");
}
