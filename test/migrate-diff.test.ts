import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	generateFromSchema,
	previewMigrationSql,
} from "../src/codegen/generate.js";

const SCHEMA_V1 = `import { defineSchema, id, table } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id() }),
});
`;

const SCHEMA_V2 = `import { defineSchema, id, table, text } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id() }),
	posts: table({ id: id(), title: text() }),
});
`;

const SCHEMA_WITH_EMAIL = `import { defineSchema, id, table, text } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id(), email: text() }),
});
`;

const SCHEMA_DROP_EMAIL = `import { defineSchema, id, table } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id() }),
});
`;

describe("previewMigrationSql", () => {
	let tmpDir: string;

	afterEach(async () => {
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	});

	async function writeWorkDir(schema: string): Promise<{
		schemaPath: string;
		outDir: string;
	}> {
		// Schemas must live inside the repo so `neoorm/schema` self-resolves
		// (same pattern as write-migration.test.ts).
		const workBaseDir = join(
			import.meta.dirname,
			"fixtures",
			"migrate-diff-work",
		);
		await mkdir(workBaseDir, { recursive: true });
		tmpDir = await mkdtemp(join(workBaseDir, "run-"));
		const schemaPath = join(tmpDir, "schema.ts");
		await writeFile(schemaPath, schema, "utf-8");
		return { schemaPath, outDir: join(tmpDir, "neoorm") };
	}

	it("shows CREATE TABLE sql for a fresh schema without writing anything", async () => {
		const { schemaPath, outDir } = await writeWorkDir(SCHEMA_V1);

		const preview = await previewMigrationSql(schemaPath, outDir);

		expect(preview.schemaChanged).toBe(true);
		expect(preview.destructiveBlocked).toBe(false);
		expect(preview.sql).toHaveLength(1);
		expect(preview.sql[0]).toMatch(/CREATE TABLE/i);
		// pure: no client files, snapshot, or migrations on disk
		await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("matches the SQL that generate would write", async () => {
		const { schemaPath, outDir } = await writeWorkDir(SCHEMA_V1);

		const preview = await previewMigrationSql(schemaPath, outDir);
		const { migrationName } = await generateFromSchema(schemaPath, outDir, {
			name: "init",
		});
		expect(migrationName).not.toBeNull();

		const written = await readFile(
			join(outDir, "migrations", String(migrationName), "migration.sql"),
			"utf-8",
		);
		expect(written).toBe(preview.sql.join("\n\n"));
	});

	it("reports no migration when the schema is unchanged", async () => {
		const { schemaPath, outDir } = await writeWorkDir(SCHEMA_V1);
		await generateFromSchema(schemaPath, outDir, { name: "init" });

		const preview = await previewMigrationSql(schemaPath, outDir);

		expect(preview.schemaChanged).toBe(false);
		expect(preview.sql).toEqual([]);
		expect(preview.destructiveBlocked).toBe(false);
	});

	it("blocks destructive changes unless --accept-data-loss is passed", async () => {
		const { schemaPath, outDir } = await writeWorkDir(SCHEMA_WITH_EMAIL);
		await generateFromSchema(schemaPath, outDir, { name: "init" });
		await writeFile(schemaPath, SCHEMA_DROP_EMAIL, "utf-8");

		const blocked = await previewMigrationSql(schemaPath, outDir);
		expect(blocked.schemaChanged).toBe(true);
		expect(blocked.destructiveBlocked).toBe(true);
		expect(blocked.sql).toEqual([]);
		expect(blocked.blocked.length).toBeGreaterThan(0);

		const accepted = await previewMigrationSql(schemaPath, outDir, {
			acceptDataLoss: true,
		});
		expect(accepted.destructiveBlocked).toBe(false);
		expect(accepted.sql.length).toBeGreaterThan(0);
	});

	it("surfaces schema errors like generate does", async () => {
		const { schemaPath, outDir } = await writeWorkDir(
			"export const nope = 1;\n",
		);

		await expect(previewMigrationSql(schemaPath, outDir)).rejects.toThrow(
			/Schema file must export a schema/,
		);
	});

	it("previews an additive change end to end", async () => {
		const { schemaPath, outDir } = await writeWorkDir(SCHEMA_V1);
		await generateFromSchema(schemaPath, outDir, { name: "init" });
		await writeFile(schemaPath, SCHEMA_V2, "utf-8");

		const preview = await previewMigrationSql(schemaPath, outDir);

		expect(preview.schemaChanged).toBe(true);
		expect(preview.sql.join("\n")).toMatch(/posts/i);
		// still pure: no new migration directory was created
		expect(await readdir(join(outDir, "migrations"))).toHaveLength(1);
	});
});
