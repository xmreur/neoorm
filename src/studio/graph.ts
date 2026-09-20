import { effectiveRelations } from "../codegen/manifest-relations.js";
import type { Manifest } from "../dialect/types.js";

export type StudioGraphNode = {
	accessor: string;
	sqlName: string;
	junction: boolean;
	columns: {
		tsName: string;
		kind: string;
		primary: boolean;
		hidden: boolean;
	}[];
};

export type StudioGraphEdge = {
	from: string;
	to: string;
	label: string;
	cardinality: "one" | "many";
	m2m: boolean;
	through?: string;
};

export type StudioGraph = {
	nodes: StudioGraphNode[];
	edges: StudioGraphEdge[];
};

/** Build ER nodes/edges from the manifest (FK + M2M, junction hops collapsed). */
export function toStudioGraph(manifest: Manifest): StudioGraph {
	const junctions = new Set(
		manifest.manyToMany.map((m) => m.throughAccessor),
	);
	const nodes: StudioGraphNode[] = Object.values(manifest.tables).map(
		(table) => ({
			accessor: table.accessor,
			sqlName: table.sqlName,
			junction: junctions.has(table.accessor),
			columns: table.columns.map((c) => ({
				tsName: c.tsName,
				kind: c.kind,
				primary: c.primary,
				hidden: c.hidden ?? false,
			})),
		}),
	);

	const edges: StudioGraphEdge[] = [];
	const seen = new Set<string>();
	const m2mPairs = new Map<string, (typeof manifest.manyToMany)[number]>();
	for (const m of manifest.manyToMany) {
		m2mPairs.set([m.leftAccessor, m.rightAccessor].sort().join("~"), m);
	}

	for (const table of Object.values(manifest.tables)) {
		for (const rel of effectiveRelations(manifest, table)) {
			const pair = [table.accessor, rel.targetAccessor].sort().join("~");
			const m2m = m2mPairs.get(pair);
			const key = m2m
				? `m2m:${pair}:${m2m.throughAccessor}`
				: `fk:${pair}:${rel.fkSqlColumn}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const label =
				rel.name === rel.inverse
					? rel.name
					: `${table.accessor}.${rel.name} ↔ ${rel.targetAccessor}.${rel.inverse}`;
			edges.push({
				from: table.accessor,
				to: rel.targetAccessor,
				label,
				cardinality: rel.cardinality,
				m2m: m2m !== undefined,
				...(m2m ? { through: m2m.throughAccessor } : {}),
			});
		}
	}

	return { nodes, edges };
}
