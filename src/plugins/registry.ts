import type { ColumnTypePlugin, NeoOrmPlugin } from "./types.js";
import { builtinPlugin } from "./builtin.js";

const pluginRegistry: NeoOrmPlugin[] = [];
const columnTypeMap = new Map<string, ColumnTypePlugin>();

let builtinsRegistered = false;

function indexColumnTypes(plugin: NeoOrmPlugin, allowOverwrite = false): void {
  for (const columnType of plugin.columnTypes) {
    if (columnTypeMap.has(columnType.kind) && !allowOverwrite) {
      const existing = columnTypeMap.get(columnType.kind);
      if (existing !== columnType) {
        throw new Error(`Duplicate column type kind registered: ${columnType.kind}`);
      }
      continue;
    }
    columnTypeMap.set(columnType.kind, columnType);
  }
}

function ensureBuiltins(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  pluginRegistry.push(builtinPlugin);
  indexColumnTypes(builtinPlugin, true);
}

export function registerPlugin(plugin: NeoOrmPlugin): void {
  ensureBuiltins();
  if (!pluginRegistry.some((p) => p.name === plugin.name)) {
    pluginRegistry.push(plugin);
  }
  indexColumnTypes(plugin, true);
}

export function getPluginRegistry(): readonly NeoOrmPlugin[] {
  ensureBuiltins();
  return pluginRegistry;
}

export function getColumnType(kind: string): ColumnTypePlugin | undefined {
  ensureBuiltins();
  if (kind === "fk") {
    return columnTypeMap.get("text");
  }
  return columnTypeMap.get(kind);
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
  pluginRegistry.length = 0;
  columnTypeMap.clear();
  builtinsRegistered = false;
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
    for (const plugin of pluginRegistry) {
      if (!plugin.columnTypes.some((columnType) => columnType.kind === kind)) {
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
  for (const columnType of columnTypeMap.values()) {
    if (columnType.introspect?.(pgDataType, udtName)) {
      return columnType;
    }
  }
  return undefined;
}
