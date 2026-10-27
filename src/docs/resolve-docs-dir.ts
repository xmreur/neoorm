import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_MARKER = "getting-started.md";

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Package-relative locations of the published NeoOrm docs. */
export function docsDirCandidates(moduleDir: string): string[] {
	return [join(moduleDir, "../../docs"), join(moduleDir, "../docs")];
}

/**
 * Find the NeoOrm documentation shipped with this package.
 * A project's own `docs/` directory is not a candidate.
 */
export async function resolveDocsDirFrom(moduleDir: string): Promise<string> {
	for (const candidate of docsDirCandidates(moduleDir)) {
		if (await exists(join(candidate, DOCS_MARKER))) {
			return candidate;
		}
	}

	throw new Error(
		"Could not find NeoOrm documentation. Reinstall the package or run from the NeoOrm repository.",
	);
}

export function resolveDocsDir(): Promise<string> {
	return resolveDocsDirFrom(dirname(fileURLToPath(import.meta.url)));
}
