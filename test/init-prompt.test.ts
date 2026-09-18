import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printInitComplete, resolveInitOptions } from "../src/init/prompt.js";

const {
	select,
	text,
	confirm,
	intro,
	outro,
	cancel,
	isCancel,
	logSuccess,
	logInfo,
} = vi.hoisted(() => ({
	select: vi.fn(),
	text: vi.fn(),
	confirm: vi.fn(),
	intro: vi.fn(),
	outro: vi.fn(),
	cancel: vi.fn(),
	isCancel: vi.fn(() => false),
	logSuccess: vi.fn(),
	logInfo: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
	select,
	text,
	confirm,
	intro,
	outro,
	cancel,
	isCancel,
	log: {
		success: logSuccess,
		info: logInfo,
	},
}));

const INIT_TMP_ROOT = join(process.cwd(), "test", ".tmp");

describe("init prompt", () => {
	let tmpDir: string;

	beforeEach(async () => {
		await mkdir(INIT_TMP_ROOT, { recursive: true });
		tmpDir = await mkdtemp(join(INIT_TMP_ROOT, "neoorm-init-prompt-"));
		select.mockReset();
		text.mockReset();
		confirm.mockReset();
		intro.mockReset();
		outro.mockReset();
		cancel.mockReset();
		isCancel.mockReset();
		isCancel.mockReturnValue(false);
		logSuccess.mockReset();
		logInfo.mockReset();
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("skips Clack prompts when flags are provided", async () => {
		const resolved = await resolveInitOptions({
			cwd: tmpDir,
			interactive: true,
			force: true,
			provider: "sqlite",
			databaseUrl: "./custom.db",
			schemaPath: "./db/schema.ts",
			outDir: "./generated",
		});

		expect(intro).toHaveBeenCalledWith("NeoOrm init");
		expect(select).not.toHaveBeenCalled();
		expect(text).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
		expect(resolved).toEqual({
			provider: "sqlite",
			schemaPath: "./db/schema.ts",
			outDir: "./generated",
			force: true,
			databaseUrl: "./custom.db",
		});
	});

	it("prompts for missing fields on a TTY", async () => {
		select.mockResolvedValue("mysql");
		text.mockResolvedValueOnce("mysql://root@localhost:3306/app")
			.mockResolvedValueOnce("./schema.ts")
			.mockResolvedValueOnce("./neoorm");

		const resolved = await resolveInitOptions({
			cwd: tmpDir,
			interactive: true,
		});

		expect(select).toHaveBeenCalledOnce();
		expect(text).toHaveBeenCalledTimes(3);
		expect(resolved.provider).toBe("mysql");
		expect(resolved.schemaPath).toBe("./schema.ts");
		expect(resolved.outDir).toBe("./neoorm");
		expect(resolved.force).toBe(false);
		expect(resolved.databaseUrl).toBe("mysql://root@localhost:3306/app");
	});

	it("omits databaseUrl when the prompted value is the provider default", async () => {
		select.mockResolvedValue("sqlite");
		text.mockResolvedValueOnce("./dev.db")
			.mockResolvedValueOnce("./schema.ts")
			.mockResolvedValueOnce("./neoorm");

		const resolved = await resolveInitOptions({
			cwd: tmpDir,
			interactive: true,
		});

		expect(resolved.provider).toBe("sqlite");
		expect(resolved.databaseUrl).toBeUndefined();
	});

	it("does not prompt when not interactive and uses defaults", async () => {
		const resolved = await resolveInitOptions({
			cwd: tmpDir,
			interactive: false,
		});

		expect(intro).not.toHaveBeenCalled();
		expect(select).not.toHaveBeenCalled();
		expect(text).not.toHaveBeenCalled();
		expect(resolved).toEqual({
			provider: "postgresql",
			schemaPath: "./schema.ts",
			outDir: "./neoorm",
			force: false,
		});
	});

	it("exits on cancel", async () => {
		select.mockResolvedValue(Symbol("clack-cancel"));
		isCancel.mockReturnValue(true);
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit:${code ?? 0}`);
		});

		try {
			await expect(
				resolveInitOptions({ cwd: tmpDir, interactive: true }),
			).rejects.toThrow("process.exit:0");
			expect(cancel).toHaveBeenCalledWith("Init cancelled.");
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			exit.mockRestore();
		}
	});

	it("sets force when overwrite is confirmed", async () => {
		await writeFile(join(tmpDir, "neoorm.config.ts"), "existing");
		confirm.mockResolvedValue(true);

		const resolved = await resolveInitOptions({
			cwd: tmpDir,
			interactive: true,
			provider: "postgresql",
			databaseUrl: "postgresql://postgres:postgres@localhost:5432/myapp",
			schemaPath: "./schema.ts",
			outDir: "./neoorm",
		});

		expect(confirm).toHaveBeenCalledOnce();
		expect(resolved.force).toBe(true);
	});

	it("exits when overwrite is declined", async () => {
		await writeFile(join(tmpDir, "neoorm.config.ts"), "existing");
		confirm.mockResolvedValue(false);
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit:${code ?? 0}`);
		});

		try {
			await expect(
				resolveInitOptions({
					cwd: tmpDir,
					interactive: true,
					provider: "postgresql",
					schemaPath: "./schema.ts",
					outDir: "./neoorm",
					databaseUrl:
						"postgresql://postgres:postgres@localhost:5432/myapp",
				}),
			).rejects.toThrow("process.exit:0");
			expect(cancel).toHaveBeenCalledWith("Init cancelled.");
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			exit.mockRestore();
		}
	});

	it("throws in non-interactive mode when scaffold files exist", async () => {
		await writeFile(join(tmpDir, ".env.example"), "DATABASE_URL=\n");

		await expect(
			resolveInitOptions({ cwd: tmpDir, interactive: false }),
		).rejects.toThrow(/already exist/);
	});

	it("prints next steps with Clack when interactive", () => {
		printInitComplete(
			{
				written: ["neoorm.config.ts"],
				skipped: [],
				outDir: "/tmp/neoorm",
				schemaPath: "/tmp/schema.ts",
			},
			["Next steps:"],
			true,
		);
		expect(logSuccess).toHaveBeenCalledWith("Scaffolded neoorm.config.ts");
		expect(outro).toHaveBeenCalledWith("Next steps:");
	});
});
