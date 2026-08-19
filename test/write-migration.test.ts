import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeMigration } from "../src/codegen/generate.js";

describe("writeMigration path handling", () => {
	let tmpDir: string;

	afterEach(async () => {
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	});

	it("sanitizes names that attempt path traversal", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-mig-"));

		const name = await writeMigration(tmpDir, ["CREATE TABLE x ();"], {
			name: "../../evil",
		});
		expect(name).not.toBe("../../evil");

		const entries = await readdir(join(tmpDir, "migrations"));
		expect(entries).toHaveLength(1);
		expect(entries[0]).toBe(name);

		// nothing was created outside the migrations directory
		const parentEntries = await readdir(tmpDir);
		expect(parentEntries).toEqual(["migrations"]);
		// and nothing above tmpDir
		const siblings = await readdir(join(tmpDir, "..")).then((entries) =>
			entries.includes("evil"),
		);
		expect(siblings).toBe(false);
	});

	it("writes a timestamped migration when no name is given", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-mig-"));

		const name = await writeMigration(tmpDir, ["CREATE TABLE x ();"]);
		expect(name).toMatch(/^\d{14}_migration$/);
		const entries = await readdir(join(tmpDir, "migrations"));
		expect(entries).toEqual([name]);
	});
});