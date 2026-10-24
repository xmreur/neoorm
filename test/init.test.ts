import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/init/scaffold.js";
import {
	envExampleTemplate,
	neoormConfigTemplate,
} from "../src/init/templates.js";
import { parseDotEnv } from "../src/utils/dotenv.js";

const INIT_TMP_ROOT = join(process.cwd(), "test", ".tmp");

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("neoorm init", () => {
	let tmpDir: string;

	beforeEach(async () => {
		await mkdir(INIT_TMP_ROOT, { recursive: true });
		tmpDir = await mkdtemp(join(INIT_TMP_ROOT, "neoorm-init-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("writes scaffold files without generating migrations or codegen output", async () => {
		const result = await runInit({ cwd: tmpDir });

		expect(result.written).toEqual([
			"neoorm.config.ts",
			"schema.ts",
			".env.example",
		]);
		expect(result.skipped).toEqual([]);

		expect(await pathExists(join(tmpDir, "neoorm.config.ts"))).toBe(true);
		expect(await pathExists(join(tmpDir, "schema.ts"))).toBe(true);
		expect(await pathExists(join(tmpDir, ".env.example"))).toBe(true);
		expect(await pathExists(join(tmpDir, "neoorm"))).toBe(false);

		const config = await readFile(
			join(tmpDir, "neoorm.config.ts"),
			"utf-8",
		);
		expect(config).toContain('schema: "./schema.ts"');
		expect(config).toContain('out: "./neoorm"');
		expect(config).toContain('provider: "postgresql"');
		expect(config).toContain(
			"// generate: { zod: true, typebox: true, elysia: true }",
		);

		const envExample = await readFile(
			join(tmpDir, ".env.example"),
			"utf-8",
		);
		expect(envExample).toContain("DATABASE_URL=");
	});

	it("scaffolds sqlite provider config and env when requested", async () => {
		await runInit({ cwd: tmpDir, provider: "sqlite" });

		const config = await readFile(
			join(tmpDir, "neoorm.config.ts"),
			"utf-8",
		);
		expect(config).toContain('provider: "sqlite"');
		expect(config).toContain('"./dev.db"');

		const envExample = await readFile(
			join(tmpDir, ".env.example"),
			"utf-8",
		);
		expect(envExample).toContain("DATABASE_URL=./dev.db");
	});

	it("fails when scaffold files already exist without --force", async () => {
		await runInit({ cwd: tmpDir });

		await expect(runInit({ cwd: tmpDir })).rejects.toThrow(/already exist/);
	});

	it("escapes hostile schema paths and database URLs in generated files", async () => {
		const schemaPath = 'sch"ema.ts';
		const outDir = "out dir";
		const databaseUrl = 'postgresql://u:p"w@localhost/db';
		await runInit({
			cwd: tmpDir,
			schemaPath,
			outDir,
			databaseUrl,
		});

		const config = await readFile(
			join(tmpDir, "neoorm.config.ts"),
			"utf-8",
		);
		expect(config).toContain(`schema: ${JSON.stringify(schemaPath)}`);
		expect(config).toContain(`out: ${JSON.stringify(outDir)}`);
		expect(config).toContain(JSON.stringify(databaseUrl));
		expect(config).not.toContain('schema: "sch"ema.ts"');

		const envExample = await readFile(
			join(tmpDir, ".env.example"),
			"utf-8",
		);
		expect(parseDotEnv(envExample)).toEqual({ DATABASE_URL: databaseUrl });
		expect(
			envExample.split("\n").filter((line) => line.length > 0),
		).toHaveLength(1);
	});

	it("keeps a newline in --database-url inside one quoted assignment", () => {
		const databaseUrl = "postgresql://localhost/db\nEVIL=1";
		const envExample = envExampleTemplate("postgresql", databaseUrl);
		expect(envExample.includes("\nEVIL")).toBe(false);
		expect(parseDotEnv(envExample)).toEqual({ DATABASE_URL: databaseUrl });
		expect(parseDotEnv(envExample).EVIL).toBeUndefined();
	});

	it("escapes newlines inside the generated config string literals", () => {
		const source = neoormConfigTemplate(
			"a\nb.ts",
			"./neoorm",
			"postgresql",
			"postgres://x\ny",
		);
		expect(source).toContain(JSON.stringify("a\nb.ts"));
		expect(source).toContain(JSON.stringify("postgres://x\ny"));
		expect(source).not.toMatch(/schema: "[^"]*\n/);
	});

	it("refuses --force paths that escape the project or collide with the config", async () => {
		await expect(
			runInit({
				cwd: tmpDir,
				schemaPath: "neoorm.config.ts",
				force: true,
			}),
		).rejects.toThrow(/cannot be neoorm\.config\.ts/);
		await expect(
			runInit({ cwd: tmpDir, schemaPath: "../schema.ts", force: true }),
		).rejects.toThrow(/inside the project directory/);
		await expect(
			runInit({ cwd: tmpDir, outDir: ".", force: true }),
		).rejects.toThrow(/project directory/);
		await expect(
			runInit({ cwd: tmpDir, outDir: "..", force: true }),
		).rejects.toThrow(/inside the project directory/);
		expect(await pathExists(join(tmpDir, "neoorm.config.ts"))).toBe(false);
	});

	it("overwrites scaffold files with --force and still generates nothing", async () => {
		await runInit({ cwd: tmpDir });

		const result = await runInit({ cwd: tmpDir, force: true });

		expect(result.written).toEqual([
			"neoorm.config.ts",
			"schema.ts",
			".env.example",
		]);
		expect(await pathExists(join(tmpDir, "neoorm"))).toBe(false);
	});
});
