import { builtinPlugin, citextPlugin } from "./builtin.js";
import type { ColumnTypePlugin, NeoOrmPlugin } from "./types.js";

// Plugin state lives on globalThis so every module instance (src vs dist, tsx
// tsImport vs Node import) shares it — a schema module loaded through tsImport
// evaluates its DSL imports in an isolated module graph, so module-local state
// would never be visible to the codegen process reading it.
const REGISTRY_KEY = Symbol.for("neoorm.pluginRegistry");
const COLUMN_TYPES_KEY = Symbol.for("neoorm.columnTypeMap");
const BUILTINS_KEY = Symbol.for("neoorm.builtinsRegistered");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GlobalState = Record<PropertyKey, any>;

function globalState(): GlobalState {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return globalThis as any;
}

function registry(): NeoOrmPlugin[] {
	return (globalState()[REGISTRY_KEY] ??= []);
}

function columnTypeMap(): Map<string, ColumnTypePlugin> {
	return (globalState()[COLUMN_TYPES_KEY] ??= new Map());
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
				throw new Error(
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
		throw new Error(
			`Unknown column kind "${kind}". Import the plugin that provides this type (e.g. import "neoorm/plugins/postgis").`,
		);
	}
	return columnType;
}

export function clearPluginRegistry(): void {
	registry().length = 0;
	columnTypeMap().clear();
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
