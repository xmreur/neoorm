import type { StudioGraphResponse } from "../api";

export type ErPosition = { x: number; y: number };
export type ErViewport = { x: number; y: number; zoom: number };

export type ErViewState = {
	version: 1;
	positions: Record<string, ErPosition>;
	showJunctions: boolean;
	viewport?: ErViewport;
};

export type ErScope = "mine" | "team";

const STORAGE_PREFIX = "neoorm-studio-er-layout:";
const SCOPE_KEY = "neoorm-studio-er-scope";
const SAVE_DEBOUNCE_MS = 300;

function hashAccessors(accessors: string[]): string {
	const sorted = [...accessors].sort().join("|");
	let hash = 5381;
	for (let i = 0; i < sorted.length; i++) {
		hash = ((hash << 5) + hash + sorted.charCodeAt(i)) | 0;
	}
	return Math.abs(hash).toString(36);
}

export function layoutKey(graph: StudioGraphResponse): string {
	return `${STORAGE_PREFIX}${hashAccessors(graph.nodes.map((n) => n.accessor))}`;
}

function sanitizePosition(value: unknown): ErPosition | null {
	if (typeof value !== "object" || value === null) return null;
	const { x, y } = value as Record<string, unknown>;
	if (typeof x !== "number" || typeof y !== "number") return null;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	return {
		x: Math.max(-100000, Math.min(100000, x)),
		y: Math.max(-100000, Math.min(100000, y)),
	};
}

function sanitizeViewport(value: unknown): ErViewport | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { x, y, zoom } = value as Record<string, unknown>;
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof zoom !== "number"
	)
		return undefined;
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom))
		return undefined;
	return {
		x: Math.max(-100000, Math.min(100000, x)),
		y: Math.max(-100000, Math.min(100000, y)),
		zoom: Math.max(0.1, Math.min(4, zoom)),
	};
}

export function parseViewState(value: unknown): ErViewState | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const raw = record.positions as Record<string, unknown> | undefined;
	if (typeof raw !== "object" || raw === null) return null;
	const positions: Record<string, ErPosition> = {};
	for (const [k, v] of Object.entries(raw)) {
		const pos = sanitizePosition(v);
		if (pos) positions[k] = pos;
	}
	return {
		version: 1,
		positions,
		showJunctions:
			typeof record.showJunctions === "boolean"
				? record.showJunctions
				: false,
		...(sanitizeViewport(record.viewport)
			? { viewport: sanitizeViewport(record.viewport) as ErViewport }
			: {}),
	};
}

export function loadLocal(key: string): ErViewState | null {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		return parseViewState(JSON.parse(raw) as unknown);
	} catch {
		return null;
	}
}

export function saveLocal(key: string, state: ErViewState): void {
	try {
		localStorage.setItem(key, JSON.stringify(state));
	} catch {
		// Quota or private mode: layout simply won't persist.
	}
}

export function clearLocal(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		// ignore
	}
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function saveLocalDebounced(key: string, state: ErViewState): void {
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveLocal(key, state);
		saveTimer = null;
	}, SAVE_DEBOUNCE_MS);
}

export function loadScope(): ErScope {
	try {
		return localStorage.getItem(SCOPE_KEY) === "team" ? "team" : "mine";
	} catch {
		return "mine";
	}
}

export function saveScope(scope: ErScope): void {
	try {
		localStorage.setItem(SCOPE_KEY, scope);
	} catch {
		// ignore
	}
}

/** Existing grid fallback, extracted from ErGraph layoutGraph. */
export function gridPositions(
	graph: StudioGraphResponse,
	showJunctions: boolean,
): Record<string, ErPosition> {
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
	const out: Record<string, ErPosition> = {};
	ordered.forEach((n, i) => {
		const col = Math.floor(i / perColumn);
		const row = i % perColumn;
		out[n.accessor] = { x: col * 300, y: row * 260 };
	});
	return out;
}

/**
 * Merge saved positions over the grid fallback.
 * Unknown accessors are dropped, new tables fall back to the grid slot.
 */
export function mergePositions(
	graph: StudioGraphResponse,
	showJunctions: boolean,
	saved: ErViewState | null,
): Record<string, ErPosition> {
	const grid = gridPositions(graph, showJunctions);
	if (!saved) return grid;
	const known = new Set(graph.nodes.map((n) => n.accessor));
	const merged: Record<string, ErPosition> = { ...grid };
	for (const [accessor, pos] of Object.entries(saved.positions)) {
		if (known.has(accessor)) merged[accessor] = pos;
	}
	return merged;
}

export function exportJson(state: ErViewState): string {
	return JSON.stringify({ ...state, version: 1 }, null, 2);
}

export function importJson(text: string): ErViewState | null {
	try {
		return parseViewState(JSON.parse(text) as unknown);
	} catch {
		return null;
	}
}
