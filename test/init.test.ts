import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/init/scaffold.js";

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
