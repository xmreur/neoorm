import type {
	Manifest,
	ManifestRelation,
	ManifestTable,
} from "../dialect/types.js";
import { primaryKeySqlName } from "../runtime/query/primary-key.js";

export function pascalCase(str: string): string {
	return str
		.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase())
		.replace(/_/g, "");
}

const IRREGULAR_SINGULARS = new Set([
	"news",
	"series",
	"species",
	"means",
	"barracks",
	"headquarters",
	"aircraft",
	"sheep",
	"deer",
	"fish",
	"moose",
	"salmon",
	"trout",
]);

export function singularTypeName(accessor: string): string {
	const pascal = pascalCase(accessor);
	if (IRREGULAR_SINGULARS.has(pascal.toLowerCase())) return pascal;
	// already-singular nouns whose final "s" is part of the word
	if (/ss$/.test(pascal) || /us$/.test(pascal) || /is$/.test(pascal)) {
		return pascal;
	}
	if (pascal.endsWith("s") && pascal.length > 1) {
		return pascal.slice(0, -1);
	}
	return pascal;
}

function uniqueRelations(table: ManifestTable): ManifestRelation[] {
	const seen = new Set<string>();
	const result: ManifestRelation[] = [];
	for (const rel of table.relations) {
		if (seen.has(rel.name)) continue;
		seen.add(rel.name);
		result.push(rel);
	}
	return result;
}

function m2mTargetColumn(manifest: Manifest, targetAccessor: string): string {
	const targetTable = manifest.tables[targetAccessor];
	if (!targetTable || targetTable.primaryKey.length === 0) return "";
	return primaryKeySqlName(targetTable);
}

function throughAccessors(manifest: Manifest): Set<string> {
	return new Set(manifest.manyToMany.map((m) => m.throughAccessor));
}

/** User-facing relations: FK/inverse plus M2M aliases, excluding junction-table hops */
export function effectiveRelations(
	manifest: Manifest,
	table: ManifestTable,
): ManifestRelation[] {
	const through = throughAccessors(manifest);
	const seen = new Set<string>();
	const result: ManifestRelation[] = [];

	for (const rel of uniqueRelations(table)) {
		if (through.has(rel.targetAccessor)) continue;
		if (seen.has(rel.name)) continue;
		seen.add(rel.name);
		result.push(rel);
	}

	for (const m2m of manifest.manyToMany) {
		if (m2m.leftAccessor === table.accessor && !seen.has(m2m.as)) {
			seen.add(m2m.as);
			result.push({
				name: m2m.as,
				targetTable: m2m.rightTable,
				targetAccessor: m2m.rightAccessor,
				fkColumn: m2m.leftFkColumn,
				fkSqlColumn: m2m.leftFkColumn,
				targetColumn: m2mTargetColumn(manifest, m2m.rightAccessor),
				cardinality: "many",
				inverse: m2m.inverse,
			});
		}
		if (m2m.rightAccessor === table.accessor && !seen.has(m2m.inverse)) {
			seen.add(m2m.inverse);
			result.push({
				name: m2m.inverse,
				targetTable: m2m.leftTable,
				targetAccessor: m2m.leftAccessor,
				fkColumn: m2m.rightFkColumn,
				fkSqlColumn: m2m.rightFkColumn,
				targetColumn: m2mTargetColumn(manifest, m2m.leftAccessor),
				cardinality: "many",
				inverse: m2m.as,
			});
		}
	}

	return result;
}
