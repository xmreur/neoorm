export type NeoOrmConfig = {
	schema: string;
	out: string;
	datasource: {
		provider: "postgresql";
		url: string;
		schema?: string;
		enum?: "check" | "union" | "native";
	};
};

const SUPPORTED_PROVIDERS = ["postgresql"] as const;
const SUPPORTED_ENUM_MODES = ["check", "union", "native"] as const;

type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];
type SupportedEnumMode = (typeof SUPPORTED_ENUM_MODES)[number];

let tsxRegisterPromise: Promise<void> | undefined;

async function ensureTsxRegistered(): Promise<void> {
	if (!tsxRegisterPromise) {
		tsxRegisterPromise = import("tsx/esm/api").then(({ register }) => {
			register();
		});
	}

	await tsxRegisterPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isSupportedProvider(value: unknown): value is SupportedProvider {
	return SUPPORTED_PROVIDERS.includes(value as SupportedProvider);
}

function isSupportedEnumMode(value: unknown): value is SupportedEnumMode {
	return SUPPORTED_ENUM_MODES.includes(value as SupportedEnumMode);
}

function requiredShapeError(): Error {
	return new Error(
		"neoorm.config.ts must export defineConfig({ schema, out, datasource: { provider, url } })",
	);
}

export function validateConfig(config: unknown): NeoOrmConfig {
	if (!isRecord(config)) {
		throw requiredShapeError();
	}

	const { schema, out, datasource } = config;
	if (!isNonEmptyString(schema) || !isNonEmptyString(out) || !isRecord(datasource)) {
		throw requiredShapeError();
	}

	if (!isNonEmptyString(datasource.url)) {
		throw requiredShapeError();
	}

	if (!isSupportedProvider(datasource.provider)) {
		throw new Error(
			`neoorm.config.ts datasource.provider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
		);
	}

	if (
		datasource.enum !== undefined &&
		!isSupportedEnumMode(datasource.enum)
	) {
		throw new Error(
			`neoorm.config.ts datasource.enum must be one of: ${SUPPORTED_ENUM_MODES.join(", ")}`,
		);
	}

	if (
		datasource.schema !== undefined &&
		typeof datasource.schema !== "string"
	) {
		throw new Error("neoorm.config.ts datasource.schema must be a string");
	}

	return {
		schema,
		out,
		datasource: {
			provider: datasource.provider,
			url: datasource.url,
			...(datasource.schema !== undefined ? { schema: datasource.schema } : {}),
			...(datasource.enum !== undefined ? { enum: datasource.enum } : {}),
		},
	};
}

export function defineConfig(config: NeoOrmConfig): NeoOrmConfig {
	return config;
}

export async function loadConfig(cwd: string): Promise<NeoOrmConfig> {
	const { join } = await import("node:path");
	const { pathToFileURL } = await import("node:url");

	await ensureTsxRegistered();

	const configPath = join(cwd, "neoorm.config.ts");
	const mod = await import(pathToFileURL(configPath).href);
	const config = mod.default ?? mod.config;

	return validateConfig(config);
}
