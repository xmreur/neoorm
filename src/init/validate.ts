import { extname, resolve } from "node:path";
import type { InitProvider } from "../datasource-provider.js";

const SCHEMA_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

export function validateSchemaPath(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return "Schema path is required";
	}
	const extension = extname(trimmed).toLowerCase();
	if (!SCHEMA_EXTENSIONS.has(extension)) {
		return "Schema path must end in .ts, .mts, or .cts";
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
	if (resolve(cwd, trimmed) === resolve(cwd, schemaPath.trim())) {
		return "Output directory cannot be the same path as the schema file";
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
	if (provider === "sqlite") {
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
	const schemaErrorMessage = validateSchemaPath(options.schemaPath);
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
