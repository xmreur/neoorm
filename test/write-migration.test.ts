import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	generateFromSchema,
	MIGRATION_SLUG_MAX_LENGTH,
	slugifyMigrationName,
	writeMigration,
} from "../src/codegen/generate.js";

const NAMED_SCHEMA = `import { defineSchema, id, table } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id() }),
});
`;

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

	it("prefixes a slugified name with a timestamp", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-mig-"));

		const name = await writeMigration(tmpDir, ["CREATE TABLE x ();"], {
			name: "Add Users",
		});
		expect(name).toMatch(/^\d{14}_add_users$/);
	});

	it("caps the slug at 50 chars", async () => {
		expect(slugifyMigrationName("a".repeat(100))).toHaveLength(
			MIGRATION_SLUG_MAX_LENGTH,
		);
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-mig-"));

		const name = await writeMigration(tmpDir, ["CREATE TABLE x ();"], {
			name: "a".repeat(100),
		});
		expect(name).toMatch(/^\d{14}_a{50}$/);
	});

	it("suffixes colliding names instead of overwriting", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-mig-"));

		const first = await writeMigration(tmpDir, ["CREATE TABLE x ();"], {
			name: "Add Users",
		});
		const second = await writeMigration(tmpDir, ["CREATE TABLE y ();"], {
			name: "Add Users",
		});
		expect(second).toBe(`${first}_1`);
		const entries = await readdir(join(tmpDir, "migrations"));
		expect(entries.sort()).toEqual([first, second].sort());
	});

	it("rejects names with no usable characters", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "neoorm-mig-"));

		await expect(
			writeMigration(tmpDir, ["CREATE TABLE x ();"], { name: "!!!" }),
		).rejects.toThrow(/Invalid migration name/);
	});
});

describe("generateFromSchema migration name enforcement", () => {
	let tmpDir: string;

	afterEach(async () => {
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	});

	async function writeSchemaDir(): Promise<{
		schemaPath: string;
		outDir: string;
	}> {
		// Schemas must live inside the repo so `neoorm/schema` self-resolves
		// (same pattern as accept-data-loss.test.ts).
		const workBaseDir = join(
			import.meta.dirname,
			"fixtures",
			"write-migration-work",
		);
		await mkdir(workBaseDir, { recursive: true });
		tmpDir = await mkdtemp(join(workBaseDir, "run-"));
		const schemaPath = join(tmpDir, "schema.ts");
		await writeFile(schemaPath, NAMED_SCHEMA, "utf-8");
		return { schemaPath, outDir: join(tmpDir, "neoorm") };
	}

	it("throws when a migration would be written without a name", async () => {
		const { schemaPath, outDir } = await writeSchemaDir();

		await expect(generateFromSchema(schemaPath, outDir)).rejects.toThrow(
			/Missing migration name/,
		);
		// nothing is written before the name check
		await expect(stat(join(outDir, "migrations"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("succeeds without a name when the schema is unchanged", async () => {
		const { schemaPath, outDir } = await writeSchemaDir();

		const first = await generateFromSchema(schemaPath, outDir, {
			name: "init",
		});
		expect(first.migrationName).toMatch(/^\d{14}_init$/);

		const second = await generateFromSchema(schemaPath, outDir);
		expect(second.migrationName).toBeNull();
	});

	it("rejects invalid names before writing", async () => {
		const { schemaPath, outDir } = await writeSchemaDir();

		await expect(
			generateFromSchema(schemaPath, outDir, { name: "!!!" }),
		).rejects.toThrow(/Invalid migration name/);
		await expect(stat(join(outDir, "migrations"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
