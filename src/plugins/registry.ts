import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { schemaError } from "../runtime/error-builders.js";
import { SchemaErrorCode } from "../runtime/error-codes.js";
import { builtinPlugin, citextPlugin } from "./builtin.js";
import type { ColumnTypePlugin, NeoOrmPlugin } from "./types.js";

// Plugin state lives on globalThis so every module instance (src vs dist, tsx
// tsImport vs Node import) shares it — a schema module loaded through tsImport
// evaluates its DSL imports in an isolated module graph, so module-local state
// would never be visible to the codegen process reading it.
const REGISTRY_KEY = Symbol.for("neoorm.pluginRegistry");
const COLUMN_TYPES_KEY = Symbol.for("neoorm.columnTypeMap");
const BUILTINS_KEY = Symbol.for("neoorm.builtinsRegistered");
const PLUGIN_MODULES_KEY = Symbol.for("neoorm.pluginModules");

function globalState(): Record<PropertyKey, unknown> {
	return globalThis as typeof globalThis & Record<PropertyKey, unknown>;
}

function registry(): NeoOrmPlugin[] {
	const state = globalState();
	const existing = state[REGISTRY_KEY];
	if (Array.isArray(existing)) {
		return existing as NeoOrmPlugin[];
	}
	const created: NeoOrmPlugin[] = [];
	state[REGISTRY_KEY] = created;
	return created;
}

function columnTypeMap(): Map<string, ColumnTypePlugin> {
	const state = globalState();
	const existing = state[COLUMN_TYPES_KEY];
	if (existing instanceof Map) {
		return existing as Map<string, ColumnTypePlugin>;
	}
	const created = new Map<string, ColumnTypePlugin>();
	state[COLUMN_TYPES_KEY] = created;
	return created;
}

function pluginModuleMap(): Map<string, string> {
	const state = globalState();
	const existing = state[PLUGIN_MODULES_KEY];
	if (existing instanceof Map) {
		return existing as Map<string, string>;
	}
	const created = new Map<string, string>();
	state[PLUGIN_MODULES_KEY] = created;
	return created;
}

function callerFilePath(): string | undefined {
	const stack = new Error().stack;
	if (!stack) return undefined;
	for (const line of stack.split("\n")) {
		if (line.includes("registry.ts") || line.includes("registry.js")) {
			continue;
		}
		const fileUrl = /file:\/\/[^\s)]+/.exec(line)?.[0];
		if (fileUrl) {
			const path = fileURLToPath(fileUrl.split("?")[0] ?? fileUrl);
			if (
				!path.endsWith("registry.ts") &&
				!path.endsWith("registry.js")
			) {
				return path;
			}
		}
		const pathMatch = /(\/[^\s:)]+\.(?:tsx|ts|jsx|js|mts|cts))/.exec(line);
		const path = pathMatch?.[1];
		if (
			path &&
			!path.endsWith("registry.ts") &&
			!path.endsWith("registry.js")
		) {
			return path;
		}
	}
	return undefined;
}

function specifierForPluginFile(
	caller: string,
	clientFile: string,
): string | undefined {
	const pluginsDir = dirname(fileURLToPath(import.meta.url));
	const relToPlugins = relative(pluginsDir, caller).replaceAll("\\", "/");
	if (
		relToPlugins === "postgis/index.ts" ||
		relToPlugins === "postgis/index.js"
	) {
		return "neoorm/plugins/postgis";
	}
	if (!relToPlugins.startsWith("..")) {
		return undefined;
	}
	let specifier = relative(dirname(clientFile), caller).replaceAll("\\", "/");
	if (!specifier.startsWith(".")) specifier = `./${specifier}`;
	if (specifier.endsWith(".ts")) specifier = `${specifier.slice(0, -3)}.js`;
	else if (specifier.endsWith(".tsx"))
		specifier = `${specifier.slice(0, -4)}.js`;
	else if (specifier.endsWith(".mts"))
		specifier = `${specifier.slice(0, -4)}.mjs`;
	else if (specifier.endsWith(".cts"))
		specifier = `${specifier.slice(0, -4)}.cjs`;
	return specifier;
}

/** Import specifiers for plugins registered by modules outside this package. */
export function pluginModulesForClient(
	clientFile: string,
	usedKinds?: readonly string[],
): string[] {
	const kindSet = usedKinds ? new Set(usedKinds) : undefined;
	const specs: string[] = [];
	const seen = new Set<string>();
	for (const [pluginName, filePath] of pluginModuleMap()) {
		const plugin = registry().find((item) => item.name === pluginName);
		if (!plugin) continue;
		if (
			kindSet &&
			!plugin.columnTypes.some((columnType) =>
				kindSet.has(columnType.kind),
			)
		) {
			continue;
		}
		const specifier = specifierForPluginFile(filePath, clientFile);
		if (!specifier || seen.has(specifier)) continue;
		seen.add(specifier);
		specs.push(specifier);
	}
	return specs;
}

function builtinsRegistered(): boolean {
	return globalState()[BUILTINS_KEY] === true;
}

function setBuiltinsRegistered(value: boolean): void {
	globalState()[BUILTINS_KEY] = value;
}

function indexColumnTypes(plugin: NeoOrmPlugin, allowOverwrite = false): void {
	for (const columnType of plugin.columnTypes) {
		if (columnTypeMap().has(columnType.kind) && !allowOverwrite) {
			const existing = columnTypeMap().get(columnType.kind);
			if (existing !== columnType) {
				throw schemaError(
					SchemaErrorCode.plugin_error,
					`Duplicate column type kind registered: ${columnType.kind}`,
				);
			}
			continue;
		}
		columnTypeMap().set(columnType.kind, columnType);
	}
}

function ensureBuiltins(): void {
	if (builtinsRegistered()) return;
	setBuiltinsRegistered(true);
	registry().push(builtinPlugin);
	indexColumnTypes(builtinPlugin, true);
	registry().push(citextPlugin);
	indexColumnTypes(citextPlugin, true);
}

/** Register a column-type plugin (call before schema compilation). */
export function registerPlugin(plugin: NeoOrmPlugin): void {
	ensureBuiltins();
	const caller = callerFilePath();
	if (caller && plugin.name !== "builtin" && plugin.name !== "citext") {
		const existing = pluginModuleMap().get(plugin.name);
		const incomingPackage = specifierForPluginFile(
			caller,
			caller,
		)?.startsWith("neoorm/");
		const existingPackage =
			existing !== undefined &&
			specifierForPluginFile(existing, existing)?.startsWith("neoorm/");
		if (
			!existing ||
			(incomingPackage === true && existingPackage !== true)
		) {
			pluginModuleMap().set(plugin.name, caller);
		}
	}
	if (!registry().some((p) => p.name === plugin.name)) {
		registry().push(plugin);
	}
	indexColumnTypes(plugin, true);
}

export function getPluginRegistry(): readonly NeoOrmPlugin[] {
	ensureBuiltins();
	return registry();
}

export function getColumnType(kind: string): ColumnTypePlugin | undefined {
	ensureBuiltins();
	if (kind === "fk") {
		return columnTypeMap().get("text");
	}
	return columnTypeMap().get(kind);
}

export function getColumnTypeOrThrow(kind: string): ColumnTypePlugin {
	const columnType = getColumnType(kind);
	if (!columnType) {
		throw schemaError(
			SchemaErrorCode.plugin_error,
			`Unknown column kind "${kind}". Import the plugin that provides this type (e.g. import "neoorm/plugins/postgis").`,
		);
	}
	return columnType;
}

export function clearPluginRegistry(): void {
	registry().length = 0;
	columnTypeMap().clear();
	pluginModuleMap().clear();
	setBuiltinsRegistered(false);
}

export function collectExtensions(plugins: readonly NeoOrmPlugin[]): string[] {
	const extensions = new Set<string>();
	for (const plugin of plugins) {
		for (const ext of plugin.extensions ?? []) {
			extensions.add(ext);
		}
	}
	return [...extensions];
}

export function collectExtensionsForKinds(kinds: readonly string[]): string[] {
	const extensions = new Set<string>();
	ensureBuiltins();

	for (const kind of kinds) {
		if (kind === "fk") continue;
		for (const plugin of registry()) {
			if (
				!plugin.columnTypes.some(
					(columnType) => columnType.kind === kind,
				)
			) {
				continue;
			}
			for (const ext of plugin.extensions ?? []) {
				extensions.add(ext);
			}
		}
	}

	return [...extensions];
}

export function findIntrospectColumnType(
	pgDataType: string,
	udtName: string,
): ColumnTypePlugin | undefined {
	ensureBuiltins();
	for (const columnType of columnTypeMap().values()) {
		if (columnType.introspect?.(pgDataType, udtName)) {
			return columnType;
		}
	}
	return undefined;
}
