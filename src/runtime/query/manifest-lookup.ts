import type {
	Manifest,
	ManifestManyToMany,
	ManifestRelation,
	ManifestTable,
} from "../../dialect/types.js";

export function findM2M(
	manifest: Manifest,
	tableAccessor: string,
	relationName: string,
): ManifestManyToMany | undefined {
	return manifest.manyToMany.find(
		(m) =>
			(m.leftAccessor === tableAccessor && m.as === relationName) ||
			(m.rightAccessor === tableAccessor && m.inverse === relationName),
	);
}

export function findRelation(
	table: ManifestTable,
	name: string,
): ManifestRelation | undefined {
	return table.relations.find((r) => r.name === name);
}

export function tableOwnsFkColumn(
	table: ManifestTable,
	rel: ManifestRelation,
): boolean {
	return table.columns.some(
		(c) => c.tsName === rel.fkColumn || c.sqlName === rel.fkSqlColumn,
	);
}
