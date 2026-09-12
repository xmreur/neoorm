import { readFile } from "node:fs/promises";
import { join } from "node:path";

function unquoteDotEnvValue(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value
			.slice(1, -1)
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1);
	}
	const comment = value.search(/\s+#/);
	if (comment >= 0) {
		return value.slice(0, comment).trimEnd();
	}
	return value;
}

/** Parse dotenv `KEY=VALUE` contents into a map. */
export function parseDotEnv(contents: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) {
			continue;
		}
		const withoutExport = line.startsWith("export ")
			? line.slice("export ".length).trim()
			: line;
		const eq = withoutExport.indexOf("=");
		if (eq <= 0) {
			continue;
		}
		const key = withoutExport.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			continue;
		}
		result[key] = unquoteDotEnvValue(withoutExport.slice(eq + 1).trim());
	}
	return result;
}

/**
 * Load `cwd/.env` into `process.env`. Existing variables are not overwritten.
 * Missing files are ignored.
 */
export async function loadDotEnv(cwd: string): Promise<void> {
	let contents: string;
	try {
		contents = await readFile(join(cwd, ".env"), "utf-8");
	} catch (err) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			err.code === "ENOENT"
		) {
			return;
		}
		throw err;
	}

	const parsed = parseDotEnv(contents);
	for (const [key, value] of Object.entries(parsed)) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}
