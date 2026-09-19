import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseProvider } from "../datasource-provider.js";
import { applySchemaToManifest } from "../dialect/postgres.js";
import { dialectForProvider } from "../dialect/resolve.js";
import type { Dialect, Manifest } from "../dialect/types.js";
import type { NeoOrmPlugin } from "../plugins/types.js";
import { schemaError } from "../runtime/error-builders.js";
import { NeoOrmSchemaError } from "../runtime/errors.js";
import { schemaCompileError } from "../runtime/schema-error.js";
import type { SchemaDef } from "../schema/define-schema.js";
import type { ColumnDef, ColumnNaming, TableDef } from "../schema/table.js";
import { resolveSqlColumnName } from "../utils/case.js";
import {
	buildDownSql,
	diffManifest,
	emptyManifest,
	formatDestructiveWarnings,
	resolveMigrationSql,
} from "./diff-manifest.js";
import { emitIncludesTs } from "./emit-includes.js";
import { emitModelsTs } from "./emit-models.js";
import { emitQueryTypesTs } from "./emit-query-types.js";
import {
	type GenerateSummary,
	summarizeGenerateOutcome,
} from "./generate-summary.js";
import { emitElysiaTs } from "./validation/emit-elysia.js";
import { emitTypeboxTs } from "./validation/emit-typebox.js";
import { emitZodTs } from "./validation/emit-zod.js";
import { validationFromManifest } from "./validation/from-manifest.js";
import { applyJsonGenericTypesFromSchema } from "./validation/json-generic-types.js";

export const ZOD_PEER_MISSING_WARNING =
	'generate.zod is enabled but "zod" is not installed. Run: bun add zod';

export const TYPEBOX_PEER_MISSING_WARNING =
	'generate.typebox is enabled but "typebox" is not installed. Run: bun add typebox';

export const ELYSIA_PEER_MISSING_WARNING =
	'generate.elysia is enabled but "elysia" is not installed. Run: bun add elysia';

/** Resolve `zod` from the app (schema directory), not from NeoOrm's own install. */
export function zodPeerWarning(fromDir: string): string | undefined {
	try {
		createRequire(join(fromDir, "package.json")).resolve("zod");
		return undefined;
	} catch {
		return ZOD_PEER_MISSING_WARNING;
	}
}

/** Resolve `typebox` from the app (schema directory), not from NeoOrm's own install. */
export function typeboxPeerWarning(fromDir: string): string | undefined {
	try {
		createRequire(join(fromDir, "package.json")).resolve("typebox");
		return undefined;
	} catch {
		return TYPEBOX_PEER_MISSING_WARNING;
	}
}

/** Resolve `elysia` from the app (schema directory), not from NeoOrm's own install. */
export function elysiaPeerWarning(fromDir: string): string | undefined {
	try {
		createRequire(join(fromDir, "package.json")).resolve("elysia");
		return undefined;
	} catch {
		return ELYSIA_PEER_MISSING_WARNING;
	}
}

async function resolvePluginRegistry(): Promise<NeoOrmPlugin[]> {
	const { getPluginRegistry } = await import("../plugins/registry.js");
	const fromDist = getPluginRegistry();
	if (fromDist.length > 1) {
		return [...fromDist];
	}

	try {
		const codegenDir = dirname(fileURLToPath(import.meta.url));
		const { getPluginRegistry: getSrcRegistry } = await import(
			join(codegenDir, "../../src/plugins/registry.js")
		);
		const fromSrc = getSrcRegistry();
		if (fromSrc.length > 1) {
			return [...fromSrc];
		}
	} catch {
		// src/ not available in published package — dist registry is authoritative
	}

	return [...fromDist];
}

function asSchemaDef(
	value: unknown,
): SchemaDef<Record<string, TableDef>> | null {
	if (value === null || typeof value !== "object") {
		return null;
	}
	const tables = Reflect.get(value, "_tables");
	if (tables === null || typeof tables !== "object") {
		return null;
	}
	return value as SchemaDef<Record<string, TableDef>>;
}

export async function loadSchemaModule(schemaPath: string): Promise<{
	schema: SchemaDef<Record<string, TableDef>>;
	plugins: NeoOrmPlugin[];
}> {
	const { importTsModule, resolveModuleExport } = await import(
		"../utils/load-ts.js"
	);

	const mod = await importTsModule(schemaPath);

	const schema = asSchemaDef(resolveModuleExport(mod, "schema"));
	if (!schema) {
		throw schemaError(
			"invalid_schema_export",
			"Schema file must export a schema via `export const schema = defineSchema(...)`",
			{ schemaPath },
			[
				"Add `export const schema = defineSchema({ ... })` to your schema file",
				"Or export default with a `schema` property",
			],
		);
	}

	const plugins = await resolvePluginRegistry();

	return { schema, plugins };
}

export function hashManifest(manifest: Manifest): string {
	return createHash("sha256")
		.update(JSON.stringify(manifest))
		.digest("hex")
		.slice(0, 16);
}

export function collectRedundantMapWarnings(schema: {
	readonly _columnNaming?: ColumnNaming;
	readonly _tables: Record<
		string,
		{
			readonly _columns: Record<string, ColumnDef>;
			readonly _columnNaming?: ColumnNaming;
		}
	>;
}): string[] {
	const warnings: string[] = [];
	const defaultColumnNaming = schema._columnNaming ?? "snakeCase";

	for (const [accessor, table] of Object.entries(schema._tables)) {
		const columnNaming = table._columnNaming ?? defaultColumnNaming;
		for (const [tsName, col] of Object.entries(table._columns)) {
			if (!("_meta" in col) || !col._meta.mapName) continue;

			const defaultName = resolveSqlColumnName(tsName, columnNaming);
			if (col._meta.mapName === defaultName) {
				warnings.push(
					`${accessor}.${tsName}.map("${col._meta.mapName}") matches the default ${columnNaming} SQL name — remove .map() or use a different name to rename the column`,
				);
			}
		}
	}

	return warnings;
}

export async function readSnapshot(outDir: string): Promise<Manifest | null> {
	try {
		const content = await readFile(join(outDir, "snapshot.json"), "utf-8");
		return JSON.parse(content) as Manifest;
	} catch {
		return null;
	}
}

export async function writeSnapshot(
	outDir: string,
	manifest: Manifest,
): Promise<void> {
	await mkdir(outDir, { recursive: true });
	await writeFile(
		join(outDir, "snapshot.json"),
		JSON.stringify(manifest, null, 2),
		"utf-8",
	);
}

export function emitManifestTs(
	manifest: Manifest,
	packageImportPath: string,
): string {
	return `// Auto-generated by neoorm generate — do not edit
import type { Manifest } from "${packageImportPath}";

export const manifest = ${JSON.stringify(manifest, null, 2)} as const satisfies Manifest;
`;
}

export function emitClientTs(
	packageImportPath: string,
	options?: { zod?: boolean; typebox?: boolean; elysia?: boolean },
): string {
	const emitZod = options?.zod === true;
	const emitTypebox = options?.typebox === true;
	const emitElysia = options?.elysia === true;
	const validationExports: string[] = [];
	if (emitZod) {
		validationExports.push('export * from "./zod.js";');
	}
	if (emitTypebox) {
		validationExports.push(
			emitZod
				? 'export * as typebox from "./typebox.js";'
				: 'export * from "./typebox.js";',
		);
	}
	if (emitElysia) {
		validationExports.push(
			emitZod || emitTypebox
				? 'export * as elysia from "./elysia.js";'
				: 'export * from "./elysia.js";',
		);
	}
	const validationBlock =
		validationExports.length > 0
			? `\n${validationExports.join("\n")}\n`
			: "";
	return `// Auto-generated by neoorm generate — do not edit
import { createNeoOrmClient } from "${packageImportPath}";
import { manifest } from "./manifest.js";
import type { NeoOrmClient } from "./query-types.js";

export const db: NeoOrmClient = createNeoOrmClient(manifest) as unknown as NeoOrmClient;

export type * from "./models.js";
export type * from "./includes.js";
export type * from "./query-types.js";
${validationBlock}`;
}

const NEOORM_PACKAGE = "neoorm";

export {
	buildDownSql,
	columnSqlType,
	columnsEqual,
	diffManifest,
	emptyManifest,
	explainNoMigrationSql,
	formatDestructiveWarnings,
	resolveMigrationSql,
} from "./diff-manifest.js";
export type { GenerateStatus, GenerateSummary } from "./generate-summary.js";
export {
	formatGenerateSummary,
	summarizeGenerateOutcome,
} from "./generate-summary.js";

function sanitizeMigrationName(name: string): string {
	const cleaned = name
		.replace(/[\\/]/g, "_")
		.replace(/\.\./g, "_")
		.replace(/\0/g, "");
	const trimmed = cleaned.trim();
	return trimmed.length > 0 ? trimmed : "migration";
}

export async function writeMigration(
	outDir: string,
	sql: string[],
	options?: {
		name?: string;
		prev?: Manifest | null;
		next?: Manifest;
		dialect?: Dialect;
	},
): Promise<string | null> {
	if (sql.length === 0) return null;

	const migrationsDir = join(outDir, "migrations");
	await mkdir(migrationsDir, { recursive: true });

	const timestamp = new Date()
		.toISOString()
		.replace(/[-:T.Z]/g, "")
		.slice(0, 14);
	const migrationName = options?.name
		? sanitizeMigrationName(options.name)
		: `${timestamp}_migration`;
	const migrationDir = join(migrationsDir, migrationName);
	await mkdir(migrationDir, { recursive: true });
	await writeFile(
		join(migrationDir, "migration.sql"),
		sql.join("\n\n"),
		"utf-8",
	);

	if (options?.next) {
		const prev = options.prev ?? null;
		const downSql = buildDownSql(prev, options.next, options.dialect);
		await writeFile(
			join(migrationDir, "down.sql"),
			downSql.join("\n\n"),
			"utf-8",
		);
		const snapshotBefore = prev ?? emptyManifest();
		await writeFile(
			join(migrationDir, "snapshot.before.json"),
			JSON.stringify(snapshotBefore, null, 2),
			"utf-8",
		);
	}

	return migrationName;
}

async function removeGeneratedFile(
	outDir: string,
	fileName: string,
): Promise<void> {
	try {
		await unlink(join(outDir, fileName));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			throw err;
		}
	}
}

export async function writeGeneratedFiles(
	outDir: string,
	manifest: Manifest,
	migrationSql: string[],
	_schemaPath: string,
	prev: Manifest | null,
	dialect?: Dialect,
	options?: {
		updateSnapshot?: boolean;
		zod?: boolean;
		typebox?: boolean;
		elysia?: boolean;
	},
): Promise<{ migrationName: string | null }> {
	await mkdir(outDir, { recursive: true });
	await writeFile(
		join(outDir, "manifest.ts"),
		emitManifestTs(manifest, NEOORM_PACKAGE),
		"utf-8",
	);
	await writeFile(
		join(outDir, "query-types.ts"),
		emitQueryTypesTs(manifest),
		"utf-8",
	);
	await writeFile(
		join(outDir, "includes.ts"),
		emitIncludesTs(manifest),
		"utf-8",
	);
	await writeFile(
		join(outDir, "models.ts"),
		emitModelsTs(manifest, NEOORM_PACKAGE),
		"utf-8",
	);

	const emitZod = options?.zod === true;
	const emitTypebox = options?.typebox === true;
	const emitElysia = options?.elysia === true;
	if (emitZod || emitTypebox || emitElysia) {
		const ir = validationFromManifest(manifest);
		if (emitZod) {
			await writeFile(join(outDir, "zod.ts"), emitZodTs(ir), "utf-8");
		} else {
			await removeGeneratedFile(outDir, "zod.ts");
		}
		if (emitTypebox) {
			await writeFile(
				join(outDir, "typebox.ts"),
				emitTypeboxTs(ir),
				"utf-8",
			);
		} else {
			await removeGeneratedFile(outDir, "typebox.ts");
		}
		if (emitElysia) {
			await writeFile(
				join(outDir, "elysia.ts"),
				emitElysiaTs(ir),
				"utf-8",
			);
		} else {
			await removeGeneratedFile(outDir, "elysia.ts");
		}
	} else {
		await removeGeneratedFile(outDir, "zod.ts");
		await removeGeneratedFile(outDir, "typebox.ts");
		await removeGeneratedFile(outDir, "elysia.ts");
	}

	await writeFile(
		join(outDir, "client.ts"),
		emitClientTs(NEOORM_PACKAGE, {
			...(emitZod ? { zod: true } : {}),
			...(emitTypebox ? { typebox: true } : {}),
			...(emitElysia ? { elysia: true } : {}),
		}),
		"utf-8",
	);

	const updateSnapshot = options?.updateSnapshot ?? true;
	if (updateSnapshot) {
		await writeSnapshot(outDir, manifest);
	}

	const migrationName = await writeMigration(outDir, migrationSql, {
		prev,
		next: manifest,
		...(dialect ? { dialect } : {}),
	});

	return { migrationName };
}

/** Result of {@link generateFromSchema}. */
export type GenerateResult = {
	manifest: Manifest;
	migrationName: string | null;
	schemaChanged: boolean;
	warnings: string[];
	destructiveBlocked: boolean;
	summary: GenerateSummary;
};

export type GenerateOptions = {
	acceptDataLoss?: boolean;
	enumMode?: "check" | "union" | "native";
	provider?: DatabaseProvider;
	schema?: string;
	url?: string;
	zod?: boolean;
	typebox?: boolean;
	elysia?: boolean;
};

export type CompileSchemaOptions = Omit<GenerateOptions, "acceptDataLoss">;

/**
 * Load `schema.ts` and compile it to a validated manifest.
 * Does not read or write `snapshot.json`.
 */
export async function compileSchemaToManifest(
	schemaPath: string,
	options: CompileSchemaOptions = {},
): Promise<{ manifest: Manifest; warnings: string[] }> {
	try {
		return await compileSchemaToManifestInner(schemaPath, options);
	} catch (err) {
		if (err instanceof NeoOrmSchemaError) {
			throw err;
		}
		throw schemaCompileError(
			schemaPath,
			err instanceof Error ? err.message : String(err),
			err,
		);
	}
}

async function compileSchemaToManifestInner(
	schemaPath: string,
	options: CompileSchemaOptions,
): Promise<{ manifest: Manifest; warnings: string[] }> {
	const { schemaToManifest, validateManifest } = await import(
		"./schema-to-manifest.js"
	);

	const { schema, plugins } = await loadSchemaModule(schemaPath);
	const schemaManifest = schemaToManifest(schema, plugins, {
		...(options.enumMode ? { enumMode: options.enumMode } : {}),
		...(options.provider ? { provider: options.provider } : {}),
		...(options.url ? { url: options.url } : {}),
	});
	const manifest = applySchemaToManifest(schemaManifest, options.schema);
	// Always resolve json()/jsonb() generics so models/query-types emit precise
	// inline types (not just `unknown`) even without zod/typebox/elysia output.
	await applyJsonGenericTypesFromSchema(schemaPath, manifest);
	const warnings = collectRedundantMapWarnings(schema);

	const errors = validateManifest(manifest);
	if (errors.length > 0) {
		const detail = errors
			.map((error, index) => `  ${index + 1}. ${error.message}`)
			.join("\n");
		const suggestions = [
			...new Set(errors.flatMap((error) => error.suggestions ?? [])),
		];
		throw schemaCompileError(
			schemaPath,
			`Schema validation failed:\n${detail}`,
			undefined,
			suggestions,
		);
	}

	return { manifest, warnings };
}

/**
 * Generate client, models, and migration SQL from a schema file.
 *
 * @param schemaPath - Path to `schema.ts`.
 * @param outDir - Output directory from config `out`.
 */
export async function generateFromSchema(
	schemaPath: string,
	outDir: string,
	options: GenerateOptions = {},
): Promise<GenerateResult> {
	try {
		return await generateFromSchemaInner(schemaPath, outDir, options);
	} catch (err) {
		if (err instanceof NeoOrmSchemaError) {
			throw err;
		}
		throw schemaCompileError(
			schemaPath,
			err instanceof Error ? err.message : String(err),
			err,
		);
	}
}

async function generateFromSchemaInner(
	schemaPath: string,
	outDir: string,
	options: GenerateOptions = {},
): Promise<GenerateResult> {
	const { manifest, warnings } = await compileSchemaToManifest(
		schemaPath,
		options,
	);

	const prev = await readSnapshot(outDir);
	const schemaChanged =
		!prev || hashManifest(prev) !== hashManifest(manifest);
	const dialect = dialectForProvider(options.provider);
	const manifestDiff = diffManifest(prev, manifest, dialect);
	const { sql, blocked } = resolveMigrationSql(
		manifestDiff,
		prev,
		manifest,
		options.acceptDataLoss ?? false,
		dialect,
	);

	const allWarnings = [...warnings];
	if (options.zod === true) {
		const missingZod = zodPeerWarning(dirname(schemaPath));
		if (missingZod !== undefined) {
			allWarnings.push(missingZod);
		}
	}
	if (options.typebox === true) {
		const missingTypebox = typeboxPeerWarning(dirname(schemaPath));
		if (missingTypebox !== undefined) {
			allWarnings.push(missingTypebox);
		}
	}
	if (options.elysia === true) {
		const missingElysia = elysiaPeerWarning(dirname(schemaPath));
		if (missingElysia !== undefined) {
			allWarnings.push(missingElysia);
		}
	}

	const migrationBlocked =
		blocked.length > 0 && !(options.acceptDataLoss ?? false);
	const migrationSql = migrationBlocked ? [] : sql;

	const { migrationName } = await writeGeneratedFiles(
		outDir,
		manifest,
		migrationSql,
		schemaPath,
		prev,
		dialect,
		{
			updateSnapshot: !migrationBlocked,
			...(options.zod === true ? { zod: true } : {}),
			...(options.typebox === true ? { typebox: true } : {}),
			...(options.elysia === true ? { elysia: true } : {}),
		},
	);

	const summary = summarizeGenerateOutcome({
		prev,
		next: manifest,
		diff: manifestDiff,
		sql: migrationSql,
		blocked,
		schemaChanged,
		migrationName,
	});

	if (summary.status === "migration_blocked") {
		allWarnings.push(...formatDestructiveWarnings(blocked));
		allWarnings.push(
			"Destructive schema changes were not written to a migration. Re-run with --accept-data-loss to include them.",
		);
	}

	return {
		manifest,
		migrationName,
		schemaChanged,
		warnings: allWarnings,
		destructiveBlocked: migrationBlocked,
		summary,
	};
}
