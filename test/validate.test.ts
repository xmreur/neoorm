import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runValidateCommand } from "../src/bin/neoorm.js";

const VALID_SCHEMA = `import { defineSchema, id, table, text } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id(), name: text() }),
	posts: table({ id: id(), title: text() }),
});
`;

const NO_EXPORT_SCHEMA = `export const notSchema = 42;
`;

const DUPLICATE_TABLE_SCHEMA = `import { defineSchema, id, table } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id() }),
	dup: table("users", { id: id() }),
});
`;

function configSource(datasource: string): string {
	return `
export default {
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: ${datasource},
};
`;
}

const SQLITE_DATASOURCE = `{
    provider: "sqlite",
    url: "file:./test.db",
  }`;

async function withProject(
	files: Record<string, string>,
	run: (dir: string) => Promise<void>,
): Promise<void> {
	const tmpRoot = join(import.meta.dirname, ".tmp");
	await mkdir(tmpRoot, { recursive: true });
	const dir = await mkdtemp(join(tmpRoot, "validate-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			await writeFile(join(dir, name), content);
		}
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("runValidateCommand", () => {
	const prevCwd = process.cwd();
	let logSpy: MockInstance;
	let warnSpy: MockInstance;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		process.chdir(prevCwd);
		vi.restoreAllMocks();
	});

	it("passes on a valid config and schema without writing output", async () => {
		await withProject(
			{
				"neoorm.config.ts": configSource(SQLITE_DATASOURCE),
				"schema.ts": VALID_SCHEMA,
			},
			async (dir) => {
				process.chdir(dir);
				await runValidateCommand();
				expect(logSpy).toHaveBeenCalledWith(
					expect.stringMatching(
						/Validation passed: config and schema are valid \(2 tables: /,
					),
				);
				expect(existsSync(join(dir, "neoorm"))).toBe(false);
			},
		);
	});

	it("rejects a config with a bad provider", async () => {
		await withProject(
			{
				"neoorm.config.ts": configSource(
					`{ provider: "oracle", url: "file:./test.db" }`,
				),
				"schema.ts": VALID_SCHEMA,
			},
			async (dir) => {
				process.chdir(dir);
				await expect(runValidateCommand()).rejects.toThrow(
					/neoorm\.config\.ts/,
				);
			},
		);
	});

	it("rejects a schema file with no schema export", async () => {
		await withProject(
			{
				"neoorm.config.ts": configSource(SQLITE_DATASOURCE),
				"schema.ts": NO_EXPORT_SCHEMA,
			},
			async (dir) => {
				process.chdir(dir);
				await expect(runValidateCommand()).rejects.toThrow(
					/must export a schema/,
				);
			},
		);
	});

	it("rejects a schema that fails manifest validation", async () => {
		await withProject(
			{
				"neoorm.config.ts": configSource(SQLITE_DATASOURCE),
				"schema.ts": DUPLICATE_TABLE_SCHEMA,
			},
			async (dir) => {
				process.chdir(dir);
				await expect(runValidateCommand()).rejects.toThrow(
					/Schema validation failed/,
				);
			},
		);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
