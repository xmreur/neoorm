import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ErLayoutPosition = { x: number; y: number };
export type ErLayoutViewport = { x: number; y: number; zoom: number };

export type SharedErLayout = {
	version: 1;
	updatedAt: string;
	positions: Record<string, ErLayoutPosition>;
	showJunctions: boolean;
	viewport?: ErLayoutViewport;
};

export const ER_LAYOUT_VERSION = 1 as const;
export const MAX_ER_LAYOUT_NODES = 2000;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function sanitizePosition(value: unknown): ErLayoutPosition | null {
	if (typeof value !== "object" || value === null) return null;
	const { x, y } = value as Record<string, unknown>;
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
	return {
		x: Math.max(-100000, Math.min(100000, x)),
		y: Math.max(-100000, Math.min(100000, y)),
	};
}

function sanitizeViewport(value: unknown): ErLayoutViewport | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null) return undefined;
	const { x, y, zoom } = value as Record<string, unknown>;
	if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(zoom))
		return undefined;
	return {
		x: Math.max(-100000, Math.min(100000, x)),
		y: Math.max(-100000, Math.min(100000, y)),
		zoom: Math.max(0.1, Math.min(4, zoom)),
	};
}

/** Validate an unknown payload into a SharedErLayout, throwing on invalid shape. */
export function parseSharedErLayout(value: unknown): SharedErLayout {
	if (typeof value !== "object" || value === null) {
		throw Object.assign(new Error("Expected an ER layout object"), {
			statusCode: 400,
			code: "invalid_args",
		});
	}
	const record = value as Record<string, unknown>;
	const positionsRaw = (record.positions ?? record.nodes) as Record<
		string,
		unknown
	>;
	if (typeof positionsRaw !== "object" || positionsRaw === null) {
		throw Object.assign(new Error("Expected `positions` in ER layout"), {
			statusCode: 400,
			code: "invalid_args",
		});
	}
	const entries = Object.entries(positionsRaw);
	if (entries.length > MAX_ER_LAYOUT_NODES) {
		throw Object.assign(new Error("ER layout exceeds node limit"), {
			statusCode: 400,
			code: "invalid_args",
		});
	}
	const positions: Record<string, ErLayoutPosition> = {};
	for (const [accessor, raw] of entries) {
		if (typeof accessor !== "string" || accessor.length === 0) continue;
		if (accessor.length > 256) continue;
		const pos = sanitizePosition(raw);
		if (pos) positions[accessor] = pos;
	}
	const showJunctions =
		typeof record.showJunctions === "boolean"
			? record.showJunctions
			: false;
	const viewport = sanitizeViewport(record.viewport);
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		positions,
		showJunctions,
		...(viewport ? { viewport } : {}),
	};
}

export async function loadSharedErLayout(
	filePath: string,
): Promise<SharedErLayout | null> {
	try {
		const text = await readFile(filePath, "utf-8");
		const parsed = JSON.parse(text) as unknown;
		const layout = parseSharedErLayout(parsed);
		// Preserve stored updatedAt when possible.
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as Record<string, unknown>).updatedAt === "string"
		) {
			return {
				...layout,
				updatedAt: (parsed as Record<string, unknown>)
					.updatedAt as string,
			};
		}
		return layout;
	} catch (err) {
		if (
			typeof err === "object" &&
			err !== null &&
			"code" in err &&
			(err as { code?: string }).code === "ENOENT"
		) {
			return null;
		}
		throw err;
	}
}

export async function saveSharedErLayout(
	filePath: string,
	layout: SharedErLayout,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(layout, null, 2)}\n`, "utf-8");
	await rename(tmp, filePath);
}
