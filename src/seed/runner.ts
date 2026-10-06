import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
	TransactionClient,
	TypedNeoOrmClient,
} from "../runtime/client.js";
import { schemaError } from "../runtime/error-builders.js";
import { SchemaErrorCode } from "../runtime/error-codes.js";
import type { TableDef } from "../schema/table.js";
import { importTsModule } from "../utils/load-ts.js";

/**
 * Transaction-scoped client passed to seed functions.
 *
 * This is the loose, manifest-agnostic context. Seed files that want full
 * per-table types should annotate with their own schema instead:
 *
 * ```ts
 * import type { TransactionClient } from "neoorm";
 * import { schema } from "./schema.js";
 *
 * export async function seed(
 * 	db: TransactionClient<typeof schema._tables>,
 * ) { ... }
 * ```
 */
export type SeedContext = TransactionClient<Record<string, TableDef>>;

/** A seed function: receives a transaction-scoped client. Runs atomically. */
export type SeedFunction = (db: SeedContext) => Promise<unknown>;

const SEED_EXTENSIONS = [".ts", ".mts", ".cts"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
	for (const path of paths) {
		if (await isFile(path)) {
			return path;
		}
	}
	return undefined;
}

export type ResolveSeedFileOptions = {
	cwd: string;
	schemaPath: string;
	env?: string;
	file?: string;
	/** `seed.file` from `neoorm.config.ts` (project-root relative). */
	configFile?: string;
};

function seedFileSuggestions(lookedFor: string[]): string[] {
	return [
		`Create ${lookedFor[0]} exporting \`export async function seed(db) { ... }\``,
		"Or pass an explicit path with --file <path>",
	];
}

/**
 * Resolve which seed file to run. Precedence: `--file` → config
 * `seed.file` → `seeds/<env>.ts` → `seed.ts` next to the schema.
 * Throws `invalid_seed` when nothing resolves.
 */
export async function resolveSeedFile(
	options: ResolveSeedFileOptions,
): Promise<string> {
	if (options.file) {
		return resolve(options.cwd, options.file);
	}
	if (options.configFile) {
		return resolve(options.cwd, options.configFile);
	}
	const schemaDir = dirname(options.schemaPath);
	if (options.env) {
		const candidates = SEED_EXTENSIONS.map((ext) =>
			join(schemaDir, "seeds", `${options.env}${ext}`),
		);
		const found = await firstExisting(candidates);
		if (!found) {
			throw schemaError(
				SchemaErrorCode.invalid_seed,
				`No seed file found for --env "${options.env}". Looked for: ${candidates.join(", ")}.`,
				undefined,
				seedFileSuggestions(candidates),
			);
		}
		return found;
	}
	const candidates = SEED_EXTENSIONS.map((ext) =>
		join(schemaDir, `seed${ext}`),
	);
	const found = await firstExisting(candidates);
	if (!found) {
		throw schemaError(
			SchemaErrorCode.invalid_seed,
			`No seed file found. Looked for: ${candidates.join(", ")}.`,
			undefined,
			seedFileSuggestions(candidates),
		);
	}
	return found;
}

/**
 * Load the `seed(db)` export from a seed file. Accepts a named `seed`
 * export or a default-exported function.
 */
export async function loadSeedFunction(
	seedPath: string,
): Promise<SeedFunction> {
	let mod: Record<string, unknown>;
	try {
		mod = await importTsModule(seedPath);
	} catch (err) {
		throw schemaError(
			SchemaErrorCode.invalid_seed,
			`Could not load seed file "${seedPath}": ${err instanceof Error ? err.message : String(err)}`,
			undefined,
			["Check the path and that the file compiles"],
		);
	}
	const exported = mod.seed;
	const defaultExport = mod.default;
	const fromDefault =
		typeof defaultExport === "function"
			? defaultExport
			: isRecord(defaultExport)
				? defaultExport.seed
				: undefined;
	const fn = exported ?? fromDefault;
	if (typeof fn !== "function") {
		throw schemaError(
			SchemaErrorCode.invalid_seed,
			`Seed file "${seedPath}" must export a seed function: \`export async function seed(db) { ... }\`.`,
			undefined,
			["Export a named `seed` function or a default function"],
		);
	}
	return fn as SeedFunction;
}

/**
 * Run a seed file inside a single transaction. Any failure rolls the whole
 * seed back, so failed runs are safe to retry. Execution errors propagate
 * unwrapped so their original code and context are preserved.
 */
export async function runSeed<TTables extends Record<string, TableDef>>(
	db: Pick<TypedNeoOrmClient<TTables>, "$transaction">,
	seedPath: string,
): Promise<void> {
	const seed = await loadSeedFunction(seedPath);
	await db.$transaction(async (tx) => {
		// The runtime shape is identical for every manifest (repositories by
		// accessor); only the static table types differ, so seed files may
		// annotate with their own `TransactionClient<typeof schema._tables>`.
		await seed(tx as SeedContext);
	});
}
