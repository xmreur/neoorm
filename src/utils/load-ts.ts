import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function importTsModule(filePath: string): Promise<any> {
	const url = pathToFileURL(filePath).href;
	if (process.versions.bun) {
		return import(url);
	}
	const { tsImport } = await import("tsx/esm/api");
	return tsImport(url, import.meta.url);
}