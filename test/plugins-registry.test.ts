import { describe, it, expect, beforeEach } from "vitest";
import {
  registerPlugin,
  getPluginRegistry,
  getColumnType,
  clearPluginRegistry,
  collectExtensions,
  collectExtensionsForKinds,
} from "../src/plugins/registry.js";
import { createColumnBuilder, type ColumnMeta } from "../src/schema/column.js";
import type { NeoOrmPlugin } from "../src/plugins/types.js";

const testPlugin: NeoOrmPlugin = {
  name: "test-plugin",
  extensions: ["test_ext"],
  columnTypes: [
    {
      kind: "custom",
      createBuilder() {
        return createColumnBuilder<string | null, ColumnMeta>({
          kind: "custom",
          nullable: true,
          unique: false,
          primary: false,
          defaultNow: false,
        });
      },
      columnType() {
        return "CUSTOM";
      },
      columnTsType(col) {
        return col.nullable ? "string | null" : "string";
      },
    },
  ],
};

describe("plugin registry", () => {
  beforeEach(() => {
    clearPluginRegistry();
  });

  it("registers builtin types by default", () => {
    const registry = getPluginRegistry();
    expect(registry.some((p) => p.name === "builtin")).toBe(true);
    expect(getColumnType("text")).toBeDefined();
    expect(getColumnType("int")).toBeDefined();
  });

  it("registers custom plugins and column types", () => {
    registerPlugin(testPlugin);
    expect(getPluginRegistry()).toHaveLength(3);
    expect(getColumnType("custom")?.columnType({} as never)).toBe("CUSTOM");
  });

  it("deduplicates plugin registration by name", () => {
    registerPlugin(testPlugin);
    registerPlugin(testPlugin);
    expect(getPluginRegistry().filter((p) => p.name === "test-plugin")).toHaveLength(1);
  });

  it("collects extensions from plugins", () => {
    registerPlugin(testPlugin);
    expect(collectExtensions(getPluginRegistry())).toEqual(["citext", "test_ext"]);
  });

  it("collects extensions only for used column kinds", () => {
    registerPlugin(testPlugin);
    expect(collectExtensionsForKinds(["custom"])).toEqual(["test_ext"]);
    expect(collectExtensionsForKinds(["text"])).toEqual([]);
  });
});
