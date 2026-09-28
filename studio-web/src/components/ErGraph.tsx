import {
	Background,
	Controls,
	type Edge,
	Handle,
	MiniMap,
	type Node,
	type OnMoveEnd,
	type OnNodesChange,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useEdgesState,
	useNodesState,
	type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type StudioErLayout, type StudioGraphResponse } from "../api";
import { navigate, tableLink, useStudio } from "../state";
import {
	clearLocal,
	type ErPosition,
	type ErScope,
	type ErViewState,
	exportJson,
	gridPositions,
	importJson,
	layoutKey,
	loadLocal,
	loadScope,
	mergePositions,
	parseViewState,
	saveLocal,
	saveLocalDebounced,
	saveScope,
} from "./er-layout";
import { Button, Empty, Spinner } from "./ui";

function buildEdges(
	graph: StudioGraphResponse,
	showJunctions: boolean,
): Edge[] {
	const ids = new Set(
		graph.nodes
			.filter((n) => showJunctions || !n.junction)
			.map((n) => n.accessor),
	);
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
	return edges;
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

function toFlowNodes(
	graph: StudioGraphResponse,
	showJunctions: boolean,
	positions: Record<string, ErPosition>,
): Node[] {
	const visible = graph.nodes.filter((n) => showJunctions || !n.junction);
	const grid = gridPositions(graph, showJunctions);
	return visible.map((n) => ({
		id: n.accessor,
		position: positions[n.accessor] ?? grid[n.accessor] ?? { x: 0, y: 0 },
		data: { graph, accessor: n.accessor },
		type: "tableNode",
	}));
}

function ErFlow({
	nodes,
	edges,
	onNodesChange,
	onNodeDragStop,
	onMoveEnd,
	defaultViewport,
	viewportKey,
}: {
	nodes: Node[];
	edges: Edge[];
	onNodesChange: OnNodesChange;
	onNodeDragStop: () => void;
	onMoveEnd: OnMoveEnd;
	defaultViewport?: Viewport;
	viewportKey: string;
}): React.JSX.Element {
	const { theme } = useStudio();
	return (
		<ReactFlow
			key={viewportKey}
			nodes={nodes}
			edges={edges}
			nodeTypes={nodeTypes}
			onNodesChange={onNodesChange}
			onNodeDragStop={onNodeDragStop}
			onMoveEnd={onMoveEnd}
			defaultViewport={defaultViewport}
			fitView={defaultViewport === undefined}
			colorMode={theme === "dark" ? "dark" : "light"}
		>
			<Background />
			<Controls />
			<MiniMap pannable zoomable />
		</ReactFlow>
	);
}

export function ErGraph(): React.JSX.Element {
	const [graph, setGraph] = useState<StudioGraphResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showJunctions, setShowJunctions] = useState(false);
	const [scope, setScope] = useState<ErScope>(() => loadScope());
	const [teamAvailable, setTeamAvailable] = useState<boolean | null>(null);
	const [savedAt, setSavedAt] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
	const [edges, setEdges] = useEdgesState<Edge>([]);
	const positionsRef = useRef<Record<string, ErPosition>>({});
	const viewportRef = useRef<Viewport | undefined>(undefined);
	const [initialViewport, setInitialViewport] = useState<
		Viewport | undefined
	>(undefined);
	const keyRef = useRef<string | null>(null);
	const initializedRef = useRef(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	const persist = useCallback(
		(next?: {
			positions?: Record<string, ErPosition>;
			showJunctions?: boolean;
			viewport?: Viewport;
		}) => {
			const key = keyRef.current;
			if (!key) return;
			if (next?.positions) positionsRef.current = next.positions;
			if (next?.viewport !== undefined)
				viewportRef.current = next.viewport;
			const state: ErViewState = {
				version: 1,
				positions: positionsRef.current,
				showJunctions: next?.showJunctions ?? showJunctions,
				...(viewportRef.current
					? {
							viewport: {
								x: viewportRef.current.x,
								y: viewportRef.current.y,
								zoom: viewportRef.current.zoom,
							},
						}
					: {}),
			};
			saveLocalDebounced(key, state);
			setSavedAt(new Date().toLocaleTimeString());
		},
		[showJunctions],
	);

	const applyState = useCallback(
		(g: StudioGraphResponse, state: ErViewState | null) => {
			const merged = mergePositions(
				g,
				state?.showJunctions ?? false,
				state,
			);
			positionsRef.current = { ...merged };
			// Keep positions for hidden junctions so toggling back restores them.
			if (state) {
				for (const [k, v] of Object.entries(state.positions)) {
					positionsRef.current[k] = v;
				}
			}
			const junctions = state?.showJunctions ?? false;
			setShowJunctions(junctions);
			setNodes(toFlowNodes(g, junctions, positionsRef.current));
			setEdges(buildEdges(g, junctions));
			viewportRef.current = state?.viewport
				? { ...state.viewport }
				: undefined;
			setInitialViewport(
				state?.viewport ? { ...state.viewport } : undefined,
			);
		},
		[setEdges, setNodes],
	);

	useEffect(() => {
		let cancelled = false;
		api.graph()
			.then((g) => {
				if (cancelled) return;
				setGraph(g);
				const key = layoutKey(g);
				keyRef.current = key;
				const local = loadLocal(key);
				applyState(g, local);
				initializedRef.current = true;
				if (local) setSavedAt("restored");
				// Probe team availability without switching scope.
				api.graphLayout()
					.then((r) => {
						if (cancelled) return;
						setTeamAvailable(r.available);
						if (loadScope() === "team" && r.layout) {
							const parsed = parseViewState(r.layout);
							if (parsed) applyState(g, parsed);
						}
					})
					.catch(() => {
						if (!cancelled) setTeamAvailable(false);
					});
			})
			.catch((err: unknown) =>
				setError(err instanceof Error ? err.message : String(err)),
			);
		return () => {
			cancelled = true;
		};
	}, [applyState]);

	const collectPositions = useCallback(
		(current: Node[]): Record<string, ErPosition> => {
			const next = { ...positionsRef.current };
			for (const n of current) {
				next[n.id] = { x: n.position.x, y: n.position.y };
			}
			return next;
		},
		[],
	);

	const handleDragStop = useCallback(() => {
		const next = collectPositions(nodes);
		positionsRef.current = next;
		persist({ positions: next });
		if (scope === "team") {
			const layout: StudioErLayout = {
				version: 1,
				positions: next,
				showJunctions,
				...(viewportRef.current
					? { viewport: { ...viewportRef.current } }
					: {}),
			};
			api.saveGraphLayout(layout).catch((err: unknown) =>
				setNotice(err instanceof Error ? err.message : String(err)),
			);
		}
	}, [collectPositions, nodes, persist, scope, showJunctions]);

	const handleMoveEnd: OnMoveEnd = useCallback(
		(_event, viewport) => {
			viewportRef.current = viewport;
			persist({ viewport });
		},
		[persist],
	);

	const handleToggleJunctions = useCallback(
		(value: boolean) => {
			if (!graph) return;
			setShowJunctions(value);
			setNodes(toFlowNodes(graph, value, positionsRef.current));
			setEdges(buildEdges(graph, value));
			persist({ showJunctions: value });
		},
		[graph, persist, setEdges, setNodes],
	);

	const handleReset = useCallback(() => {
		if (!graph || !keyRef.current) return;
		clearLocal(keyRef.current);
		const grid = gridPositions(graph, showJunctions);
		positionsRef.current = { ...grid };
		viewportRef.current = undefined;
		setInitialViewport(undefined);
		setNodes(toFlowNodes(graph, showJunctions, grid));
		saveLocal(keyRef.current, {
			version: 1,
			positions: grid,
			showJunctions,
		});
		setSavedAt(new Date().toLocaleTimeString());
		setNotice("Layout reset to auto-grid");
	}, [graph, showJunctions, setNodes]);

	const handleScopeChange = useCallback(
		(next: ErScope) => {
			setScope(next);
			saveScope(next);
			setNotice(null);
			if (next === "team" && graph) {
				api.graphLayout()
					.then((r) => {
						setTeamAvailable(r.available);
						if (r.layout) {
							const parsed = parseViewState(r.layout);
							if (parsed) {
								applyState(graph, parsed);
								setNotice("Loaded team layout");
							}
						} else {
							setNotice(
								"No team layout yet — arrange and Push to team",
							);
						}
					})
					.catch((err: unknown) =>
						setNotice(
							err instanceof Error
								? `Team layout unavailable: ${err.message}`
								: "Team layout unavailable",
						),
					);
			}
		},
		[applyState, graph],
	);

	const handlePushTeam = useCallback(() => {
		const layout: StudioErLayout = {
			version: 1,
			positions: collectPositions(nodes),
			showJunctions,
			...(viewportRef.current
				? { viewport: { ...viewportRef.current } }
				: {}),
		};
		api.saveGraphLayout(layout)
			.then(() => {
				setTeamAvailable(true);
				setNotice("Pushed layout to team");
			})
			.catch((err: unknown) =>
				setNotice(err instanceof Error ? err.message : String(err)),
			);
	}, [collectPositions, nodes, showJunctions]);

	const handlePullTeam = useCallback(() => {
		if (!graph) return;
		api.graphLayout()
			.then((r) => {
				setTeamAvailable(r.available);
				if (r.layout) {
					const parsed = parseViewState(r.layout);
					if (parsed) {
						applyState(graph, parsed);
						setNotice("Pulled team layout");
					}
				} else {
					setNotice("No team layout saved yet");
				}
			})
			.catch((err: unknown) =>
				setNotice(err instanceof Error ? err.message : String(err)),
			);
	}, [applyState, graph]);

	const handleExport = useCallback(() => {
		const key = keyRef.current;
		const local = key ? loadLocal(key) : null;
		const state: ErViewState = {
			version: 1,
			positions: collectPositions(nodes),
			showJunctions,
			...(viewportRef.current
				? { viewport: { ...viewportRef.current } }
				: {}),
			...(local ? {} : {}),
		};
		const blob = new Blob([exportJson(state)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "neoorm-er-layout.json";
		a.click();
		URL.revokeObjectURL(url);
	}, [collectPositions, nodes, showJunctions]);

	const handleImportFile = useCallback(
		(file: File) => {
			if (!graph) return;
			void file.text().then((text) => {
				const parsed = importJson(text);
				if (!parsed) {
					setNotice("Invalid layout file");
					return;
				}
				applyState(graph, parsed);
				if (keyRef.current) saveLocal(keyRef.current, parsed);
				setSavedAt(new Date().toLocaleTimeString());
				setNotice("Imported layout from file");
			});
		},
		[applyState, graph],
	);

	const viewportKey = useMemo(
		() =>
			graph
				? `${layoutKey(graph)}:${initialViewport ? "saved" : "auto"}`
				: "loading",
		[graph, initialViewport],
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
			<div className="flex flex-wrap items-center gap-2">
				<h1 className="text-base font-semibold">Relations</h1>
				<span className="text-xs text-muted-foreground">
					{graph.nodes.length} tables • {edges.length} links • drag
					tables to rearrange
				</span>
				{savedAt ? (
					<span className="text-xs text-muted-foreground">
						saved {savedAt}
					</span>
				) : null}
				<div className="ml-auto flex items-center gap-2 text-xs">
					<label className="flex items-center gap-1.5">
						<input
							type="checkbox"
							checked={showJunctions}
							onChange={(e) =>
								handleToggleJunctions(e.target.checked)
							}
						/>
						Show junction tables
					</label>
					<label className="flex items-center gap-1">
						Scope:
						<select
							value={scope}
							onChange={(e) =>
								handleScopeChange(e.target.value as ErScope)
							}
							className="rounded border border-border bg-card px-1 py-0.5"
							title="Mine = this browser only. Team = shared file via --er-layout."
						>
							<option value="mine">Mine</option>
							<option value="team">Team</option>
						</select>
					</label>
				</div>
			</div>
			{notice ? (
				<p className="text-xs text-muted-foreground">{notice}</p>
			) : null}
			{scope === "team" && teamAvailable === false ? (
				<p className="text-xs text-muted-foreground">
					Team layout not enabled on this server (restart with{" "}
					<span className="mono">
						--er-layout ./neoorm.er-layout.json
					</span>
					). Local layout still works.
				</p>
			) : null}
			<div className="min-h-0 flex-1 rounded-md border border-border">
				<ReactFlowProvider>
					<ErFlow
						nodes={nodes}
						edges={edges}
						onNodesChange={onNodesChange}
						onNodeDragStop={handleDragStop}
						onMoveEnd={handleMoveEnd}
						defaultViewport={initialViewport}
						viewportKey={viewportKey}
					/>
				</ReactFlowProvider>
			</div>
			<div className="flex flex-wrap gap-2 text-xs">
				<Button
					variant="outline"
					size="sm"
					onClick={() => handleToggleJunctions(!showJunctions)}
				>
					{showJunctions ? "Hide junctions" : "Show junctions"}
				</Button>
				<Button variant="outline" size="sm" onClick={handleReset}>
					Reset layout
				</Button>
				<Button variant="outline" size="sm" onClick={handleExport}>
					Export JSON
				</Button>
				<Button
					variant="outline"
					size="sm"
					onClick={() => fileInputRef.current?.click()}
				>
					Import JSON
				</Button>
				{scope === "team" ? (
					<>
						<Button
							variant="outline"
							size="sm"
							onClick={handlePushTeam}
						>
							Push to team
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={handlePullTeam}
						>
							Pull from team
						</Button>
					</>
				) : null}
				<input
					ref={fileInputRef}
					type="file"
					accept="application/json"
					className="hidden"
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) handleImportFile(file);
						e.target.value = "";
					}}
				/>
			</div>
		</div>
	);
}
