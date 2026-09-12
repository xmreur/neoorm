import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Public function exports that must have a TSDoc block in their source file. */
const DOCUMENTED_FUNCTIONS: { export: string; file: string }[] = [
	{ export: "defineSchema", file: "src/schema/define-schema.ts" },
	{ export: "table", file: "src/schema/table.ts" },
	{ export: "fk", file: "src/schema/relation.ts" },
	{ export: "many", file: "src/schema/many-to-many.ts" },
	{ export: "timestamps", file: "src/schema/column.ts" },
	{ export: "id", file: "src/plugins/builtin.ts" },
	{ export: "text", file: "src/plugins/builtin.ts" },
	{ export: "createNeoOrmClient", file: "src/runtime/client.ts" },
	{ export: "createNeoOrmClientFromPool", file: "src/runtime/client.ts" },
	{ export: "encodeCursor", file: "src/runtime/query/cursor-codec.ts" },
	{ export: "decodeCursor", file: "src/runtime/query/cursor-codec.ts" },
	{ export: "defineConfig", file: "src/config.ts" },
	{ export: "loadConfig", file: "src/config.ts" },
	{ export: "schemaToManifest", file: "src/codegen/schema-to-manifest.ts" },
	{ export: "validateManifest", file: "src/codegen/schema-to-manifest.ts" },
	{ export: "generateFromSchema", file: "src/codegen/generate.ts" },
	{ export: "migrateDeploy", file: "src/migrate/runner.ts" },
	{ export: "migrateDown", file: "src/migrate/runner.ts" },
	{ export: "dbPush", file: "src/migrate/runner.ts" },
	{ export: "registerPlugin", file: "src/plugins/registry.ts" },
	{ export: "geometry", file: "src/plugins/postgis/columns.ts" },
];

/** Fluent builder methods that must have TSDoc on their interface declaration. */
const DOCUMENTED_BUILDER_METHODS: { method: string; file: string }[] = [
	{ method: "notNull", file: "src/schema/column.ts" },
	{ method: "unique", file: "src/schema/column.ts" },
	{ method: "index", file: "src/schema/column.ts" },
	{ method: "hidden", file: "src/schema/column.ts" },
	{ method: "default", file: "src/schema/column.ts" },
	{ method: "primary", file: "src/schema/column.ts" },
	{ method: "map", file: "src/schema/column.ts" },
	{ method: "check", file: "src/schema/column.ts" },
	{ method: "defaultNow", file: "src/schema/column.ts" },
	{ method: "updatedAt", file: "src/schema/column.ts" },
	{ method: "as", file: "src/schema/relation.ts" },
	{ method: "inverse", file: "src/schema/relation.ts" },
	{ method: "onDelete", file: "src/schema/relation.ts" },
	{ method: "where", file: "src/schema/table.ts" },
];

function hasDocstringBeforeMethod(source: string, methodName: string): boolean {
	const pattern = new RegExp(
		`/\\*\\*[\\s\\S]*?\\*/\\s*${methodName}(?:<[^>]*>)?\\(`,
	);
	return pattern.test(source);
}

function hasDocstringBeforeExport(source: string, exportName: string): boolean {
	const patterns = [
		new RegExp(`/\\*\\*[\\s\\S]*?\\*/\\s*export function ${exportName}\\b`),
		new RegExp(
			`/\\*\\*[\\s\\S]*?\\*/\\s*export async function ${exportName}\\b`,
		),
		new RegExp(`/\\*\\*[\\s\\S]*?\\*/\\s*export const ${exportName}\\s*=`),
	];
	return patterns.some((pattern) => pattern.test(source));
}

describe("api docstrings", () => {
	for (const { export: exportName, file } of DOCUMENTED_FUNCTIONS) {
		it(`${exportName} in ${file} has a docstring`, () => {
			const source = readFileSync(join(root, file), "utf-8");
			expect(hasDocstringBeforeExport(source, exportName)).toBe(true);
		});
	}

	for (const { method, file } of DOCUMENTED_BUILDER_METHODS) {
		it(`${method}() in ${file} has a docstring`, () => {
			const source = readFileSync(join(root, file), "utf-8");
			expect(hasDocstringBeforeMethod(source, method)).toBe(true);
		});
	}

	it("emits docstrings into dist declaration files after build", () => {
		const defineSchemaDts = readFileSync(
			join(root, "dist/schema/define-schema.d.ts"),
			"utf-8",
		);
		const clientDts = readFileSync(
			join(root, "dist/runtime/client.d.ts"),
			"utf-8",
		);
		const columnDts = readFileSync(
			join(root, "dist/schema/column.d.ts"),
			"utf-8",
		);
		const relationDts = readFileSync(
			join(root, "dist/schema/relation.d.ts"),
			"utf-8",
		);
		expect(defineSchemaDts).toMatch(/\/\*\*[\s\S]*defineSchema/);
		expect(clientDts).toMatch(/\/\*\*[\s\S]*createNeoOrmClient/);
		expect(columnDts).toMatch(/\/\*\*[\s\S]*notNull/);
		expect(relationDts).toMatch(/\/\*\*[\s\S]*onDelete/);
	});
});
