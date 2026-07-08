import type {
	Manifest,
	ManifestColumn,
	ManifestRelation,
	ManifestTable,
} from "../../dialect/types.js";
import { buildFindAllQuery, buildFindByIdQuery } from "./compile.js";
import { getColumnType } from "../../plugins/registry.js";

export type TableIndex = {
	columnsByTsName: Map<string, ManifestColumn>;
	relationsByName: Map<string, ManifestRelation>;
	findAllSql: string;
	findByIdSql: string;
	deserializeColumns: ManifestColumn[];
};

export type ManifestIndex = Map<string, TableIndex>;

export function buildTableIndex(table: ManifestTable): TableIndex {
	const columnsByTsName = new Map(
		table.columns.map((col) => [col.tsName, col]),
	);
	const relationsByName = new Map(
		table.relations.map((rel) => [rel.name, rel]),
	);
	const deserializeColumns = table.columns.filter((col) => {
		if (col.kind === "fk") return false;
		const plugin = getColumnType(col.kind);
		return plugin?.deserializeValue != null;
	});

	let findByIdSql = "";
	try {
		findByIdSql = buildFindByIdQuery(table);
	} catch {
		findByIdSql = "";
	}

	return {
		columnsByTsName,
		relationsByName,
		findAllSql: buildFindAllQuery(table),
		findByIdSql,
		deserializeColumns,
	};
}

export function buildManifestIndex(manifest: Manifest): ManifestIndex {
	const index = new Map<string, TableIndex>();
	for (const [accessor, table] of Object.entries(manifest.tables)) {
		index.set(accessor, buildTableIndex(table));
	}
	return index;
}

export function getTableIndex(
	index: ManifestIndex | undefined,
	tableAccessor: string,
): TableIndex | undefined {
	return index?.get(tableAccessor);
}
