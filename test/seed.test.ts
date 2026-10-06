import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineSchema, id, table, text } from "neoorm/schema";
import { afterEach, describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { createNeoOrmClientFromSqlite } from "../src/runtime/client.js";
import { SchemaErrorCode } from "../src/runtime/error-codes.js";
import { NeoOrmSchemaError } from "../src/runtime/errors.js";
import {
	loadSeedFunction,
	resolveSeedFile,
	runSeed,
} from "../src/seed/runner.js";

const schema = defineSchema({
	tags: table({
		id: id(),
		name: text().unique(),
	}),
});

const FIXTURE_SCHEMA = `import { defineSchema, id, table, text } from "neoorm/schema";

export const schema = defineSchema({
	tags: table({
		id: id(),
		name: text().unique(),
	}),
});
`;

const SEED_BASIC = `import type { TransactionClient } from "neoorm";
import { schema } from "./schema.js";

export async function seed(db: TransactionClient<typeof schema._tables>) {
	await db.tags.createMany({
		data: [{ name: "alpha" }, { name: "beta" }],
		skipDuplicates: true,
	});
}
`;

const SEED_DEFAULT_EXPORT = `export default async function (db: any) {
	await db.tags.createMany({ data: [{ name: "gamma" }] });
}
`;

const SEED_FAILING = `import type { TransactionClient } from "neoorm";
import { schema } from "./schema.js";

export async function seed(db: TransactionClient<typeof schema._tables>) {
	await db.tags.createMany({ data: [{ name: "doomed" }] });
	throw new Error("boom halfway");
}
`;

const SEED_NO_EXPORT = `export const notSeed = 1;
`;

function openSeedClient() {
	const database = new DatabaseSync(":memory:");
	const manifest = schemaToManifest(schema);
	const tags = manifest.tables.tags;
	if (!tags) {
		throw new Error("expected tags table");
	}
	database.exec(sqliteDialect.emitCreateTable(tags, { manifest }));
	return {
		database,
		db: createNeoOrmClientFromSqlite<typeof schema._tables>(
			manifest,
			database,
		),
	};
}

describe("seed runner", () => {
	let tmpDir: string;
	const databases: DatabaseSync[] = [];

	afterEach(async () => {
		for (const database of databases.splice(0)) {
			database.close();
		}
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	});

	async function writeWorkDir(files: Record<string, string>): Promise<{
		schemaPath: string;
		dir: string;
	}> {
		// Seed fixtures must live inside the repo so `neoorm` self-resolves.
		const workBaseDir = join(import.meta.dirname, "fixtures", "seed-work");
		await mkdir(workBaseDir, { recursive: true });
		tmpDir = await mkdtemp(join(workBaseDir, "run-"));
		const schemaPath = join(tmpDir, "schema.ts");
		await writeFile(schemaPath, FIXTURE_SCHEMA, "utf-8");
		for (const [name, content] of Object.entries(files)) {
			const full = join(tmpDir, name);
			await mkdir(join(full, ".."), { recursive: true });
			await writeFile(full, content, "utf-8");
		}
		return { schemaPath, dir: tmpDir };
	}

	it("runs a seed and writes rows", async () => {
		const { dir, schemaPath } = await writeWorkDir({
			"seed.ts": SEED_BASIC,
		});
		const { database, db } = openSeedClient();
		databases.push(database);

		const seedPath = await resolveSeedFile({
			cwd: dir,
			schemaPath,
		});
		await runSeed(db, seedPath);

		const rows = await db.tags.findMany({ orderBy: { name: "asc" } });
		expect(rows.map((row) => row.name)).toEqual(["alpha", "beta"]);
	});

	it("re-running an idempotent seed succeeds", async () => {
		const { dir, schemaPath } = await writeWorkDir({
			"seed.ts": SEED_BASIC,
		});
		const { database, db } = openSeedClient();
		databases.push(database);

		const seedPath = await resolveSeedFile({
			cwd: dir,
			schemaPath,
		});
		await runSeed(db, seedPath);
		await runSeed(db, seedPath);

		const rows = await db.tags.findMany({});
		expect(rows).toHaveLength(2);
	});

	it("rolls back when the seed throws", async () => {
		const { dir, schemaPath } = await writeWorkDir({
			"seed.ts": SEED_FAILING,
		});
		const { database, db } = openSeedClient();
		databases.push(database);

		const seedPath = await resolveSeedFile({
			cwd: dir,
			schemaPath,
		});
		await expect(runSeed(db, seedPath)).rejects.toThrow("boom halfway");

		const rows = await db.tags.findMany({});
		expect(rows).toEqual([]);
	});

	it("supports a default-exported function", async () => {
		const { dir, schemaPath } = await writeWorkDir({
			"seed.ts": SEED_DEFAULT_EXPORT,
		});
		const { database, db } = openSeedClient();
		databases.push(database);

		const seedPath = await resolveSeedFile({
			cwd: dir,
			schemaPath,
		});
		await runSeed(db, seedPath);

		const rows = await db.tags.findMany({});
		expect(rows.map((row) => row.name)).toEqual(["gamma"]);
	});

	it("rejects seed files without a seed export", async () => {
		const { dir, schemaPath } = await writeWorkDir({
			"seed.ts": SEED_NO_EXPORT,
		});

		const seedPath = await resolveSeedFile({
			cwd: dir,
			schemaPath,
		});
		await expect(loadSeedFunction(seedPath)).rejects.toMatchObject({
			name: "NeoOrmSchemaError",
		});
		try {
			await loadSeedFunction(seedPath);
		} catch (err) {
			expect(err).toBeInstanceOf(NeoOrmSchemaError);
			expect((err as NeoOrmSchemaError).code).toBe(
				SchemaErrorCode.invalid_seed,
			);
		}
	});

	it("errors clearly when no seed file exists", async () => {
		const { dir, schemaPath } = await writeWorkDir({});

		await expect(resolveSeedFile({ cwd: dir, schemaPath })).rejects.toThrow(
			/No seed file found/,
		);
	});

	it("resolves --env to seeds/<env>.ts", async () => {
		const { dir, schemaPath } = await writeWorkDir({
			"seed.ts": SEED_BASIC,
			"seeds/dev.ts": SEED_DEFAULT_EXPORT,
		});

		const seedPath = await resolveSeedFile({
			cwd: dir,
			schemaPath,
			env: "dev",
		});
		expect(seedPath.endsWith(join("seeds", "dev.ts"))).toBe(true);

		await expect(
			resolveSeedFile({ cwd: dir, schemaPath, env: "prod" }),
		).rejects.toThrow(/--env "prod"/);
	});

	it("prefers --file over everything else", async () => {
		const { dir, schemaPath } = await writeWorkDir({
			"seed.ts": SEED_BASIC,
			"custom.ts": SEED_DEFAULT_EXPORT,
		});

		const seedPath = await resolveSeedFile({
			cwd: dir,
			schemaPath,
			env: "dev",
			file: "custom.ts",
			configFile: "seed.ts",
		});
		expect(seedPath.endsWith("custom.ts")).toBe(true);
	});
});
