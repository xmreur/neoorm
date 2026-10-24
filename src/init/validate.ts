import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { InitProvider } from "../datasource-provider.js";
import { foreignDatabaseScheme } from "../runtime/sqlite-open.js";

const CONFIG_FILE = "neoorm.config.ts";
const ENV_EXAMPLE_FILE = ".env.example";

function hasControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

/** True when `abs` is `cwd` or a descendant of it. */
export function isInsideProject(cwd: string, abs: string): boolean {
	const rel = relative(resolve(cwd), abs);
	if (rel === "") return true;
	if (isAbsolute(rel)) return false;
	return rel !== ".." && !rel.startsWith(`..${sep}`);
}

const SCHEMA_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

export function validateSchemaPath(
	value: string,
	cwd?: string,
): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return "Schema path is required";
	}
	if (hasControlChar(trimmed)) {
		return "Schema path cannot contain control characters";
	}
	const extension = extname(trimmed).toLowerCase();
	if (!SCHEMA_EXTENSIONS.has(extension)) {
		return "Schema path must end in .ts, .mts, or .cts";
	}
	if (cwd === undefined) return undefined;
	const abs = resolve(cwd, trimmed);
	const root = resolve(cwd);
	if (abs === root || !isInsideProject(root, abs)) {
		return "Schema path must stay inside the project directory";
	}
	if (abs === resolve(root, CONFIG_FILE)) {
		return "Schema path cannot be neoorm.config.ts";
	}
	if (abs === resolve(root, ENV_EXAMPLE_FILE)) {
		return "Schema path cannot be .env.example";
	}
	return undefined;
}

export function validateOutDir(
	value: string,
	schemaPath: string,
	cwd: string,
): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return "Output directory is required";
	}
	if (hasControlChar(trimmed)) {
		return "Output directory cannot contain control characters";
	}
	const root = resolve(cwd);
	const outPath = resolve(root, trimmed);
	if (outPath === root) {
		return "Output directory cannot be the project directory";
	}
	if (!isInsideProject(root, outPath)) {
		return "Output directory must stay inside the project directory";
	}
	if (outPath === resolve(root, schemaPath.trim())) {
		return "Output directory cannot be the same path as the schema file";
	}
	if (outPath === resolve(root, CONFIG_FILE)) {
		return "Output directory cannot be neoorm.config.ts";
	}
	return undefined;
}

export function validateDatabaseUrl(
	value: string,
	provider: InitProvider,
): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return "Database URL is required";
	}
	if (hasControlChar(trimmed)) {
		return "Database URL cannot contain control characters";
	}
	if (provider === "sqlite") {
		const scheme = foreignDatabaseScheme(trimmed);
		if (scheme !== undefined) {
			return `Database URL is a ${scheme} connection URL, not a SQLite path`;
		}
		return undefined;
	}
	if (!trimmed.includes("://")) {
		return "Database URL must include a scheme (e.g. postgresql://...)";
	}
	return undefined;
}

export function assertInitAnswers(options: {
	cwd: string;
	provider: InitProvider;
	schemaPath: string;
	outDir: string;
	databaseUrl: string;
}): void {
	const schemaErrorMessage = validateSchemaPath(
		options.schemaPath,
		options.cwd,
	);
	if (schemaErrorMessage) {
		throw new Error(schemaErrorMessage);
	}
	const outErrorMessage = validateOutDir(
		options.outDir,
		options.schemaPath,
		options.cwd,
	);
	if (outErrorMessage) {
		throw new Error(outErrorMessage);
	}
	const urlErrorMessage = validateDatabaseUrl(
		options.databaseUrl,
		options.provider,
	);
	if (urlErrorMessage) {
		throw new Error(urlErrorMessage);
	}
}
