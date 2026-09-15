import { join } from "node:path";
import {
	DATABASE_PROVIDERS,
	type DatabaseProvider,
	isDatabaseProvider,
} from "./datasource-provider.js";
import { schemaError } from "./runtime/error-builders.js";
import { SchemaErrorCode } from "./runtime/error-codes.js";
import { loadDotEnv } from "./utils/dotenv.js";
import { importTsModule } from "./utils/load-ts.js";

export type NeoOrmConfig = {
	/** Path to `schema.ts`. */
	schema: string;
	/** Output directory for generated client and migrations. */
	out: string;
	datasource: {
		/** Database provider. `"postgres"` is accepted as an alias of `"postgresql"`. */
		provider: DatabaseProvider;
		/** Connection URL or SQLite file path. */
		url: string;
		/** PostgreSQL schema name. */
		schema?: string;
		/** Enum storage mode for PostgreSQL. @default "check" */
		enum?: "check" | "union" | "native";
	};
	generate?: {
		/** Emit Zod Select/Create/Update schemas to `out/zod.ts`. @default false */
		zod?: boolean;
		/** Emit TypeBox Select/Create/Update schemas to `out/typebox.ts`. @default false */
		typebox?: boolean;
		/** Emit Elysia `t` Select/Create/Update schemas to `out/elysia.ts`. @default false */
		elysia?: boolean;
	};
};

const SUPPORTED_ENUM_MODES = ["check", "union", "native"] as const;

type SupportedEnumMode = (typeof SUPPORTED_ENUM_MODES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isSupportedEnumMode(value: unknown): value is SupportedEnumMode {
	return SUPPORTED_ENUM_MODES.includes(value as SupportedEnumMode);
}

function requiredShapeError(): never {
	throw schemaError(
		SchemaErrorCode.invalid_config,
		"neoorm.config.ts must export defineConfig({ schema, out, datasource: { provider, url } })",
	);
}

export function validateConfig(config: unknown): NeoOrmConfig {
	if (!isRecord(config)) {
		throw requiredShapeError();
	}

	const { schema, out, datasource } = config;
	if (
		!isNonEmptyString(schema) ||
		!isNonEmptyString(out) ||
		!isRecord(datasource)
	) {
		throw requiredShapeError();
	}

	if (!isNonEmptyString(datasource.url)) {
		throw requiredShapeError();
	}

	if (!isDatabaseProvider(datasource.provider)) {
		throw schemaError(
			SchemaErrorCode.invalid_config,
			`neoorm.config.ts datasource.provider must be one of: ${DATABASE_PROVIDERS.join(", ")}`,
		);
	}

	if (
		datasource.enum !== undefined &&
		!isSupportedEnumMode(datasource.enum)
	) {
		throw schemaError(
			SchemaErrorCode.invalid_config,
			`neoorm.config.ts datasource.enum must be one of: ${SUPPORTED_ENUM_MODES.join(", ")}`,
		);
	}

	if (
		datasource.schema !== undefined &&
		typeof datasource.schema !== "string"
	) {
		throw schemaError(
			SchemaErrorCode.invalid_config,
			"neoorm.config.ts datasource.schema must be a string",
		);
	}

	const generate = parseGenerateOptions(config.generate);

	return {
		schema,
		out,
		datasource: {
			provider: datasource.provider,
			url: datasource.url,
			...(datasource.schema !== undefined
				? { schema: datasource.schema }
				: {}),
			...(datasource.enum !== undefined ? { enum: datasource.enum } : {}),
		},
		...(generate ? { generate } : {}),
	};
}

function parseGenerateOptions(
	value: unknown,
): NeoOrmConfig["generate"] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw schemaError(
			SchemaErrorCode.invalid_config,
			"neoorm.config.ts generate must be an object",
		);
	}
	const zod = parseGenerateFlag(value.zod, "zod");
	const typebox = parseGenerateFlag(value.typebox, "typebox");
	const elysia = parseGenerateFlag(value.elysia, "elysia");
	if (zod === undefined && typebox === undefined && elysia === undefined) {
		return undefined;
	}
	return {
		...(zod !== undefined ? { zod } : {}),
		...(typebox !== undefined ? { typebox } : {}),
		...(elysia !== undefined ? { elysia } : {}),
	};
}

function parseGenerateFlag(
	value: unknown,
	key: "zod" | "typebox" | "elysia",
): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw schemaError(
			SchemaErrorCode.invalid_config,
			`neoorm.config.ts generate.${key} must be a boolean`,
		);
	}
	return value;
}

/** Type-safe config object for `neoorm.config.ts`. */
export function defineConfig(config: NeoOrmConfig): NeoOrmConfig {
	return config;
}

/**
 * Load and validate `neoorm.config.ts` from a project directory.
 *
 * Loads `cwd/.env` first (without overwriting existing environment variables)
 * so `process.env.DATABASE_URL` is available when the config module evaluates.
 *
 * @param cwd - Project root containing `neoorm.config.ts`.
 */
export async function loadConfig(cwd: string): Promise<NeoOrmConfig> {
	await loadDotEnv(cwd);

	const configPath = join(cwd, "neoorm.config.ts");
	const mod = await importTsModule(configPath);
	const candidate = mod.default ?? mod.config;
	// tsx wraps a CommonJS default export as mod.default = { default: <config> },
	// so unwrap it when present.
	const config =
		isRecord(candidate) && isRecord(candidate.default)
			? candidate.default
			: candidate;

	return validateConfig(config);
}
