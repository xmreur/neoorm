import { readFile } from "node:fs/promises";
import { join } from "node:path";

function unescapeDoubleQuotedChar(next: string): string {
	switch (next) {
		case "n":
			return "\n";
		case "r":
			return "\r";
		case "t":
			return "\t";
		case '"':
			return '"';
		case "\\":
			return "\\";
		default:
			return `\\${next}`;
	}
}

/**
 * Quoted value, including one that is followed by an inline comment
 * (`'abc'#c` or `"abc" # comment`). `undefined` when `value` is not quoted.
 * Double quotes unescape `\\` before `\n` / `\t`, so `"\\n"` stays backslash + n.
 */
function readQuotedValue(value: string): string | undefined {
	const quote = value[0];
	if (quote !== '"' && quote !== "'") return undefined;
	let out = "";
	for (let i = 1; i < value.length; i++) {
		const ch = value[i];
		if (ch === undefined) break;
		if (quote === '"' && ch === "\\") {
			const next = value[i + 1];
			if (next === undefined) {
				out += "\\";
				break;
			}
			out += unescapeDoubleQuotedChar(next);
			i += 1;
			continue;
		}
		if (quote === "'" && ch === "\\" && value[i + 1] === "'") {
			out += "'";
			i += 1;
			continue;
		}
		if (ch === quote) {
			const rest = value.slice(i + 1).trim();
			if (rest.length === 0 || rest.startsWith("#")) return out;
			return undefined;
		}
		out += ch;
	}
	return undefined;
}

function unquoteDotEnvValue(value: string): string {
	const quoted = readQuotedValue(value);
	if (quoted !== undefined) return quoted;
	const comment = value.search(/\s+#/);
	if (comment >= 0) {
		return value.slice(0, comment).trimEnd();
	}
	return value;
}

/** `export KEY` and `export\tKEY`. `export=value` stays a key named export. */
function stripExportPrefix(line: string): string {
	if (!line.startsWith("export")) return line;
	const rest = line.slice("export".length);
	const first = rest[0];
	if (first === undefined || !/\s/.test(first)) return line;
	return rest.trim();
}

/** Parse dotenv `KEY=VALUE` contents into a map. */
export function parseDotEnv(contents: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) {
			continue;
		}
		const withoutExport = stripExportPrefix(line);
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
