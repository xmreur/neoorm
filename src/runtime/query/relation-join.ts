import {
	relationFkPairs,
	relationReferencedSqlColumns,
} from "../../dialect/fk.js";
import type {
	Dialect,
	ManifestRelation,
	ManifestTable,
} from "../../dialect/types.js";
import { primaryKeySqlName } from "./primary-key.js";
import type { TableIndex } from "./table-index.js";
import { columnByTsName } from "./table-index.js";

export function ownedFkJoinPredicate(
	dialect: Dialect,
	parentTable: ManifestTable,
	parentTableIndex: TableIndex | undefined,
	parentRef: string,
	relAlias: string,
	relation: ManifestRelation,
): string {
	return relationFkPairs(relation)
		.map((pair) => {
			const parentCol =
				columnByTsName(parentTableIndex, parentTable, pair.fkColumn) ??
				parentTable.columns.find(
					(col) =>
						col.tsName === pair.fkColumn ||
						col.sqlName === pair.fkSqlColumn,
				);
			const parentFkRef = parentCol
				? `${parentRef}.${dialect.quoteIdentifier(parentCol.sqlName)}`
				: `${parentRef}.${dialect.quoteIdentifier(pair.fkSqlColumn)}`;
			return `${dialect.quoteIdentifier(relAlias)}.${dialect.quoteIdentifier(pair.targetColumn)} = ${parentFkRef}`;
		})
		.join(" AND ");
}

export function inverseFkJoinPredicate(
	dialect: Dialect,
	childAlias: string,
	parentRef: string,
	relation: ManifestRelation,
	parentPkSql: string,
): string {
	const pairs = relationFkPairs(relation);
	const refs = relationReferencedSqlColumns(relation, parentPkSql);
	return pairs
		.map((pair, i) => {
			const parentCol = refs[i] ?? parentPkSql;
			return `${dialect.quoteIdentifier(childAlias)}.${dialect.quoteIdentifier(pair.fkSqlColumn)} = ${parentRef}.${dialect.quoteIdentifier(parentCol)}`;
		})
		.join(" AND ");
}

/** Parent values for each inverse FK column, in pair order. */
export function inverseFkParentValues(
	relation: ManifestRelation,
	parentTable: ManifestTable,
	parentRow: Record<string, unknown>,
): unknown[] {
	const pairs = relationFkPairs(relation);
	const refs = relationReferencedSqlColumns(
		relation,
		primaryKeySqlName(parentTable),
	);
	return pairs.map((pair, i) => {
		const ref = refs[i] ?? pair.targetColumn;
		const col = parentTable.columns.find(
			(item) => item.sqlName === ref || item.tsName === ref,
		);
		const ts = col?.tsName ?? ref;
		return parentRow[ts];
	});
}

export function inverseFkMatchKey(
	relation: ManifestRelation,
	parentTable: ManifestTable,
	parentRow: Record<string, unknown>,
): string {
	return inverseFkParentValues(relation, parentTable, parentRow)
		.map((value) => String(value ?? ""))
		.join("\0");
}
