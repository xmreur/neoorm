import {
	cancel,
	confirm,
	intro,
	isCancel,
	log,
	outro,
	select,
	text,
} from "@clack/prompts";
import type { InitProvider } from "../datasource-provider.js";
import { schemaError } from "../runtime/error-builders.js";
import { SchemaErrorCode } from "../runtime/error-codes.js";
import {
	DEFAULT_OUT_DIR,
	DEFAULT_SCHEMA_PATH,
	type InitResult,
	listExistingScaffoldFiles,
} from "./scaffold.js";
import { defaultDatabaseUrl } from "./templates.js";
import {
	assertInitAnswers,
	validateDatabaseUrl,
	validateOutDir,
	validateSchemaPath,
} from "./validate.js";

export type InitPromptFlags = {
	cwd: string;
	interactive: boolean;
	force?: boolean;
	provider?: InitProvider;
	databaseUrl?: string;
	schemaPath?: string;
	outDir?: string;
};

export type ResolvedInitOptions = {
	provider: InitProvider;
	databaseUrl?: string;
	schemaPath: string;
	outDir: string;
	force: boolean;
};

function exitIfCancelled<T>(value: T): Exclude<T, symbol> {
	if (isCancel(value)) {
		cancel("Init cancelled.");
		process.exit(0);
	}
	return value as Exclude<T, symbol>;
}

async function promptProvider(initial: InitProvider): Promise<InitProvider> {
	const selected = await select({
		message: "Database provider",
		initialValue: initial,
		options: [
			{
				value: "postgresql",
				label: "PostgreSQL",
				hint: "recommended",
			},
			{
				value: "sqlite",
				label: "SQLite",
				hint: "file-based",
			},
			{ value: "mysql", label: "MySQL" },
			{ value: "mariadb", label: "MariaDB" },
		],
	});
	return exitIfCancelled(selected);
}

async function promptText(
	message: string,
	defaultValue: string,
	validate: (value: string) => string | undefined,
): Promise<string> {
	const value = await text({
		message,
		defaultValue,
		placeholder: defaultValue,
		validate: (input) => validate((input ?? "").trim() || defaultValue),
	});
	const resolved = exitIfCancelled(value);
	return (resolved ?? "").trim() || defaultValue;
}

export async function resolveInitOptions(
	flags: InitPromptFlags,
): Promise<ResolvedInitOptions> {
	if (flags.interactive) {
		intro("NeoOrm init");
	}

	const provider: InitProvider =
		flags.provider ??
		(flags.interactive ? await promptProvider("postgresql") : "postgresql");

	const defaultUrl = defaultDatabaseUrl(provider);
	const databaseUrlInput = flags.databaseUrl
		? flags.databaseUrl.trim()
		: flags.interactive
			? await promptText("Database URL", defaultUrl, (value) =>
					validateDatabaseUrl(value, provider),
				)
			: defaultUrl;

	const schemaPath = flags.schemaPath
		? flags.schemaPath.trim()
		: flags.interactive
			? await promptText(
					"Schema file path",
					DEFAULT_SCHEMA_PATH,
					(value) => validateSchemaPath(value),
				)
			: DEFAULT_SCHEMA_PATH;

	const outDir = flags.outDir
		? flags.outDir.trim()
		: flags.interactive
			? await promptText(
					"Generated output directory",
					DEFAULT_OUT_DIR,
					(value) => validateOutDir(value, schemaPath, flags.cwd),
				)
			: DEFAULT_OUT_DIR;

	assertInitAnswers({
		cwd: flags.cwd,
		provider,
		schemaPath,
		outDir,
		databaseUrl: databaseUrlInput,
	});

	let force = flags.force === true;
	const existing = await listExistingScaffoldFiles(flags.cwd, schemaPath);
	if (existing.length > 0 && !force) {
		if (!flags.interactive) {
			throw schemaError(
				SchemaErrorCode.migration_guard,
				`Scaffold files already exist: ${existing.join(", ")}. Re-run with --force to overwrite.`,
			);
		}
		const overwrite = await confirm({
			message: `Overwrite existing files? (${existing.join(", ")})`,
			initialValue: false,
		});
		if (!exitIfCancelled(overwrite)) {
			cancel("Init cancelled.");
			process.exit(0);
		}
		force = true;
	}

	return {
		provider,
		schemaPath,
		outDir,
		force,
		...(flags.databaseUrl || databaseUrlInput !== defaultUrl
			? { databaseUrl: databaseUrlInput }
			: {}),
	};
}

export function printInitComplete(
	result: InitResult,
	nextSteps: string[],
	interactive: boolean,
): void {
	if (interactive) {
		if (result.written.length > 0) {
			log.success(`Scaffolded ${result.written.join(", ")}`);
		}
		if (result.skipped.length > 0) {
			log.info(`Skipped ${result.skipped.join(", ")}`);
		}
		outro(nextSteps.join("\n"));
		return;
	}

	if (result.written.length > 0) {
		console.log("Scaffolded:");
		for (const file of result.written) {
			console.log(`  + ${file}`);
		}
	}
	if (result.skipped.length > 0) {
		console.log("Skipped (already exists):");
		for (const file of result.skipped) {
			console.log(`  - ${file}`);
		}
	}
	for (const line of nextSteps) {
		console.log(line);
	}
}
