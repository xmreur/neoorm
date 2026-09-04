import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function resolveDocsDir(): Promise<string> {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(moduleDir, "../../docs"),
		join(moduleDir, "../docs"),
		join(process.cwd(), "docs"),
	];

	for (const candidate of candidates) {
		if (await exists(candidate)) {
			return candidate;
		}
	}

	throw new Error(
		"Could not find NeoOrm documentation. Reinstall the package or run from the NeoOrm repository.",
	);
}
