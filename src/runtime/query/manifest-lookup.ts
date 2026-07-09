import type {
	Manifest,
	ManifestManyToMany,
	ManifestRelation,
	ManifestTable,
} from "../../dialect/types.js";
import {
	relationByName,
	type TableIndex,
	tableOwnsFk,
} from "./table-index.js";

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
	tableIndex?: TableIndex,
): ManifestRelation | undefined {
	return relationByName(tableIndex, table, name);
}

export function tableOwnsFkColumn(
	table: ManifestTable,
	rel: ManifestRelation,
	tableIndex?: TableIndex,
): boolean {
	return tableOwnsFk(tableIndex, table, rel);
}
