import {
	Background,
	Controls,
	type Edge,
	Handle,
	MiniMap,
	type Node,
	Position,
	ReactFlow,
	ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import { api, type StudioGraphResponse } from "../api";
import { navigate, tableLink, useStudio } from "../state";
import { Button, Empty, Spinner } from "./ui";

function layoutGraph(
	graph: StudioGraphResponse,
	showJunctions: boolean,
): { nodes: Node[]; edges: Edge[] } {
	const visible = graph.nodes.filter((n) => showJunctions || !n.junction);
	const degree = new Map<string, number>();
	for (const e of graph.edges) {
		degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
		degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
	}
	const ordered = [...visible].sort(
		(a, b) => (degree.get(b.accessor) ?? 0) - (degree.get(a.accessor) ?? 0),
	);
	const perColumn = 4;
	const nodes: Node[] = ordered.map((n, i) => {
		const col = Math.floor(i / perColumn);
		const row = i % perColumn;
		return {
			id: n.accessor,
			position: { x: col * 300, y: row * 260 },
			data: { label: n.accessor },
			type: "tableNode",
		};
	});
	const ids = new Set(visible.map((n) => n.accessor));
	const edges: Edge[] = [];
	const seen = new Set<string>();
	for (const e of graph.edges) {
		if (!ids.has(e.from) || !ids.has(e.to)) continue;
		const key = [e.from, e.to].sort().join("~");
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push({
			id: `${e.from}-${e.to}`,
			source: e.from,
			target: e.to,
			label: e.m2m ? "n:n" : e.cardinality === "many" ? "1:n" : "1:1",
			animated: e.m2m,
			style: e.m2m ? { strokeDasharray: "6 4" } : undefined,
		});
	}
	return { nodes, edges };
}

function TableNode({
	data,
}: {
	data: { graph: StudioGraphResponse; accessor: string };
}): React.JSX.Element {
	const node = data.graph.nodes.find((n) => n.accessor === data.accessor);
	if (!node) return <div />;
	return (
		<div className="xy-node-card">
			<Handle type="target" position={Position.Left} />
			<button
				type="button"
				className="w-full cursor-pointer px-2 py-1 text-left font-semibold hover:underline"
				onClick={() => navigate(tableLink(node.accessor))}
				title={`Open ${node.accessor} data`}
			>
				{node.accessor}
				{node.junction ? (
					<span className="ml-1 font-normal text-muted-foreground">
						(junction)
					</span>
				) : null}
			</button>
			<ul className="max-h-40 overflow-auto border-t border-border px-2 py-1">
				{node.columns.map((c) => (
					<li
						key={c.tsName}
						className="mono truncate text-[11px]"
						title={`${c.tsName} (${c.kind})`}
					>
						<span
							className={
								c.primary
									? "font-bold"
									: c.hidden
										? "text-muted-foreground italic"
										: ""
							}
						>
							{c.tsName}
						</span>
						<span className="text-muted-foreground">
							{" "}
							: {c.kind}
						</span>
					</li>
				))}
			</ul>
			<Handle type="source" position={Position.Right} />
		</div>
	);
}

const nodeTypes = { tableNode: TableNode };

export function ErGraph(): React.JSX.Element {
	const { theme } = useStudio();
	const [graph, setGraph] = useState<StudioGraphResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showJunctions, setShowJunctions] = useState(false);

	useEffect(() => {
		api.graph()
			.then(setGraph)
			.catch((err: unknown) =>
				setError(err instanceof Error ? err.message : String(err)),
			);
	}, []);

	const { nodes, edges } = useMemo(
		() =>
			graph
				? layoutGraph(graph, showJunctions)
				: { nodes: [], edges: [] },
		[graph, showJunctions],
	);
	const flowNodes: Node[] = useMemo(
		() =>
			nodes.map((n) => ({
				...n,
				data: { graph, accessor: n.id },
			})),
		[nodes, graph],
	);

	if (error) return <Empty title="Could not load the graph" hint={error} />;
	if (!graph)
		return (
			<p className="p-6 text-sm text-muted-foreground">
				<Spinner /> Loading graph…
			</p>
		);

	return (
		<div className="flex h-full flex-col gap-2 p-3">
			<div className="flex items-center gap-2">
				<h1 className="text-base font-semibold">Relations</h1>
				<span className="text-xs text-muted-foreground">
					{graph.nodes.length} tables • {edges.length} links • click a
					table to open its data
				</span>
				<label className="ml-auto flex items-center gap-1.5 text-xs">
					<input
						type="checkbox"
						checked={showJunctions}
						onChange={(e) => setShowJunctions(e.target.checked)}
					/>
					Show junction tables
				</label>
			</div>
			<div className="min-h-0 flex-1 rounded-md border border-border">
				<ReactFlowProvider>
					<ReactFlow
						nodes={flowNodes}
						edges={edges}
						nodeTypes={nodeTypes}
						fitView
						colorMode={theme === "dark" ? "dark" : "light"}
					>
						<Background />
						<Controls />
						<MiniMap pannable zoomable />
					</ReactFlow>
				</ReactFlowProvider>
			</div>
			<div className="flex gap-2 text-xs">
				<Button
					variant="outline"
					size="sm"
					onClick={() => setShowJunctions((v) => !v)}
				>
					{showJunctions ? "Hide junctions" : "Show junctions"}
				</Button>
			</div>
		</div>
	);
}
