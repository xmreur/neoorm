import { access, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { InitProvider } from "../datasource-provider.js";
import { schemaError } from "../runtime/error-builders.js";
import { SchemaErrorCode } from "../runtime/error-codes.js";
import {
	envExampleTemplate,
	neoormConfigTemplate,
	schemaTemplate,
} from "./templates.js";

export type InitOptions = {
	cwd?: string;
	schemaPath?: string;
	outDir?: string;
	force?: boolean;
	provider?: InitProvider;
	databaseUrl?: string;
};

export type InitResult = {
	written: string[];
	skipped: string[];
	outDir: string;
	schemaPath: string;
};

export const CONFIG_FILE = "neoorm.config.ts";
export const ENV_EXAMPLE_FILE = ".env.example";
export const DEFAULT_SCHEMA_PATH = "./schema.ts";
export const DEFAULT_OUT_DIR = "./neoorm";

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function toDisplayPath(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath);
	return rel.startsWith("..") ? absolutePath : rel || ".";
}

export function resolveScaffoldTargets(
	cwd: string,
	schemaRel: string,
): Array<{ path: string; label: string }> {
	const schemaPath = resolve(cwd, schemaRel);
	return [
		{ path: join(cwd, CONFIG_FILE), label: CONFIG_FILE },
		{ path: schemaPath, label: toDisplayPath(cwd, schemaPath) },
		{ path: join(cwd, ENV_EXAMPLE_FILE), label: ENV_EXAMPLE_FILE },
	];
}

export async function listExistingScaffoldFiles(
	cwd: string,
	schemaRel: string,
): Promise<string[]> {
	const existing: string[] = [];
	for (const target of resolveScaffoldTargets(cwd, schemaRel)) {
		if (await fileExists(target.path)) {
			existing.push(target.label);
		}
	}
	return existing;
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const schemaRel = options.schemaPath ?? DEFAULT_SCHEMA_PATH;
	const outRel = options.outDir ?? DEFAULT_OUT_DIR;
	const schemaPath = resolve(cwd, schemaRel);
	const outDir = resolve(cwd, outRel);
	const configPath = join(cwd, CONFIG_FILE);
	const envExamplePath = join(cwd, ENV_EXAMPLE_FILE);

	const existing = await listExistingScaffoldFiles(cwd, schemaRel);

	if (existing.length > 0 && !options.force) {
		throw schemaError(
			SchemaErrorCode.migration_guard,
			`Scaffold files already exist: ${existing.join(", ")}. Re-run with --force to overwrite.`,
		);
	}

	const provider = options.provider ?? "postgresql";

	const written: string[] = [];
	const skipped: string[] = [];

	const filesToWrite: Array<{
		path: string;
		label: string;
		content: string;
	}> = [
		{
			path: configPath,
			label: CONFIG_FILE,
			content: neoormConfigTemplate(
				schemaRel,
				outRel,
				provider,
				options.databaseUrl,
			),
		},
		{
			path: schemaPath,
			label: toDisplayPath(cwd, schemaPath),
			content: schemaTemplate(),
		},
		{
			path: envExamplePath,
			label: ENV_EXAMPLE_FILE,
			content: envExampleTemplate(provider, options.databaseUrl),
		},
	];

	for (const file of filesToWrite) {
		if (!options.force && (await fileExists(file.path))) {
			skipped.push(file.label);
			continue;
		}
		await writeFile(file.path, file.content, "utf-8");
		written.push(file.label);
	}

	return { written, skipped, outDir, schemaPath };
}

export function formatInitNextSteps(
	cwd: string,
	schemaPath: string,
	outDir: string,
): string[] {
	const schemaImport = toDisplayPath(cwd, resolve(schemaPath));
	const clientImport = `${outDir.replace(/^\.\//, "")}/client.js`;
	return [
		"Next steps:",
		"  1. cp .env.example .env  # set DATABASE_URL",
		"  2. neoorm migrate dev    # generate client + first migration and apply it",
		`  3. import { db } from "./${clientImport}"`,
		`     # schema: ${schemaImport}`,
	];
}
