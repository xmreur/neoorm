import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
	generateFromSchema,
	hashManifest,
	readSnapshot,
} from "../src/codegen/generate.js";

const SCHEMA_V1 = `import { defineSchema, id, table } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id() }),
	archives: table({ id: id() }),
});
`;

const SCHEMA_V2 = `import { defineSchema, id, table } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id() }),
});
`;

async function writeSchema(
	dir: string,
	content: string,
	fileName = "schema.ts",
): Promise<string> {
	const schemaPath = join(dir, fileName);
	await writeFile(schemaPath, content, "utf-8");
	return schemaPath;
}

const workBaseDir = join(
	import.meta.dirname,
	"fixtures",
	"accept-data-loss-work",
);

async function createWorkDir(): Promise<string> {
	await mkdir(workBaseDir, { recursive: true });
	return mkdtemp(join(workBaseDir, "run-"));
}

describe("accept-data-loss generate flow", () => {
	it("keeps snapshot unchanged when destructive migration is blocked", async () => {
		const workDir = await createWorkDir();
		const outDir = join(workDir, "neoorm");
		const schemaV1Path = await writeSchema(
			workDir,
			SCHEMA_V1,
			"schema-v1.ts",
		);

		await generateFromSchema(schemaV1Path, outDir);
		const snapshotAfterV1 = await readSnapshot(outDir);
		expect(snapshotAfterV1?.tables.archives).toBeDefined();

		const schemaV2Path = await writeSchema(
			workDir,
			SCHEMA_V2,
			"schema-v2.ts",
		);
		const blocked = await generateFromSchema(schemaV2Path, outDir);
		expect(blocked.destructiveBlocked).toBe(true);
		expect(blocked.summary.status).toBe("migration_blocked");
		expect(blocked.migrationName).toBeNull();

		const snapshotAfterBlocked = await readSnapshot(outDir);
		expect(snapshotAfterBlocked).not.toBeNull();
		expect(hashManifest(snapshotAfterBlocked!)).toBe(
			hashManifest(snapshotAfterV1!),
		);
		expect(snapshotAfterBlocked?.tables.archives).toBeDefined();

		const migrationsDir = join(outDir, "migrations");
		const migrationDirsAfterBlock = await readdir(migrationsDir);
		expect(migrationDirsAfterBlock).toHaveLength(1);

		await rm(workDir, { recursive: true, force: true });
	});

	it("writes destructive migration and updates snapshot with acceptDataLoss", async () => {
		const workDir = await createWorkDir();
		const outDir = join(workDir, "neoorm");
		const schemaV1Path = await writeSchema(
			workDir,
			SCHEMA_V1,
			"schema-v1.ts",
		);

		await generateFromSchema(schemaV1Path, outDir);
		const schemaV2Path = await writeSchema(
			workDir,
			SCHEMA_V2,
			"schema-v2.ts",
		);

		const accepted = await generateFromSchema(schemaV2Path, outDir, {
			acceptDataLoss: true,
		});
		expect(accepted.destructiveBlocked).toBe(false);
		expect(accepted.migrationName).not.toBeNull();

		const snapshotAfterAccept = await readSnapshot(outDir);
		expect(snapshotAfterAccept?.tables.archives).toBeUndefined();

		const migrationsDir = join(outDir, "migrations");
		const migrationDirs = await readdir(migrationsDir);
		expect(migrationDirs.length).toBeGreaterThanOrEqual(1);

		let foundDropTable = false;
		for (const dir of migrationDirs) {
			const migrationSql = await readFile(
				join(migrationsDir, dir, "migration.sql"),
				"utf-8",
			);
			if (migrationSql.toUpperCase().includes("DROP TABLE")) {
				foundDropTable = true;
			}
		}
		expect(foundDropTable).toBe(true);

		await rm(workDir, { recursive: true, force: true });
	});

	it("still produces destructive migration after a blocked generate", async () => {
		const workDir = await createWorkDir();
		const outDir = join(workDir, "neoorm");
		const schemaV1Path = await writeSchema(
			workDir,
			SCHEMA_V1,
			"schema-v1.ts",
		);

		await generateFromSchema(schemaV1Path, outDir);
		const schemaV2Path = await writeSchema(
			workDir,
			SCHEMA_V2,
			"schema-v2.ts",
		);

		const blocked = await generateFromSchema(schemaV2Path, outDir);
		expect(blocked.destructiveBlocked).toBe(true);

		const accepted = await generateFromSchema(schemaV2Path, outDir, {
			acceptDataLoss: true,
		});
		expect(accepted.destructiveBlocked).toBe(false);
		expect(accepted.migrationName).not.toBeNull();
		expect(accepted.summary.status).toBe("migration_created");

		await rm(workDir, { recursive: true, force: true });
	});
});

describe("CLI --accept-data-loss parsing", () => {
	it("passes --accept-data-loss to generate when positional options are enabled", async () => {
		const program = new Command();
		program.enablePositionalOptions();

		let acceptDataLoss: boolean | undefined;
		program
			.command("generate")
			.option(
				"--accept-data-loss",
				"Include destructive schema changes in generated migrations",
			)
			.action((options: { acceptDataLoss?: boolean }) => {
				acceptDataLoss = options.acceptDataLoss;
			});

		await program.parseAsync(["generate", "--accept-data-loss"], {
			from: "user",
		});

		expect(acceptDataLoss).toBe(true);
	});

	it("passes --accept-data-loss to migrate dev when positional options are enabled", async () => {
		const program = new Command();
		program.enablePositionalOptions();

		let migrateAcceptDataLoss: boolean | undefined;
		program
			.command("migrate")
			.argument("[subcommand]", "dev | deploy")
			.option(
				"--accept-data-loss",
				"Include destructive schema changes in generated migrations",
			)
			.action(
				(
					_subcommand: string | undefined,
					options: { acceptDataLoss?: boolean },
				) => {
					migrateAcceptDataLoss = options.acceptDataLoss;
				},
			);

		await program.parseAsync(["migrate", "dev", "--accept-data-loss"], {
			from: "user",
		});

		expect(migrateAcceptDataLoss).toBe(true);
	});

	it("does not steal --accept-data-loss on a sibling db push command", async () => {
		const program = new Command();
		program.enablePositionalOptions();

		const db = program.command("db");
		let pushAcceptDataLoss: boolean | undefined;
		let generateAcceptDataLoss: boolean | undefined;

		db.command("push")
			.option("--accept-data-loss", "Apply destructive schema changes")
			.action((options: { acceptDataLoss?: boolean }) => {
				pushAcceptDataLoss = options.acceptDataLoss;
			});

		program
			.command("generate")
			.option("--accept-data-loss", "Include destructive schema changes")
			.action((options: { acceptDataLoss?: boolean }) => {
				generateAcceptDataLoss = options.acceptDataLoss;
			});

		await program.parseAsync(["generate", "--accept-data-loss"], {
			from: "user",
		});

		expect(generateAcceptDataLoss).toBe(true);
		expect(pushAcceptDataLoss).toBeUndefined();
	});
});
