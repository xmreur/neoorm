import { pathToFileURL } from "node:url";

export function resolveModuleExport(
	mod: Record<string, unknown>,
	exportName: string,
): unknown {
	const direct = mod[exportName];
	if (direct !== undefined) {
		return direct;
	}
	const nested = mod.default;
	if (nested !== null && typeof nested === "object") {
		const record = nested as Record<string, unknown>;
		const fromDefault = record[exportName];
		return fromDefault !== undefined ? fromDefault : nested;
	}
	return undefined;
}

export async function importTsModule(
	filePath: string,
): Promise<Record<string, unknown>> {
	const url = pathToFileURL(filePath).href;
	if (process.versions.bun) {
		return import(url) as Promise<Record<string, unknown>>;
	}
	const { tsImport } = await import("tsx/esm/api");
	return tsImport(url, import.meta.url) as Promise<Record<string, unknown>>;
}
