import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateFromSchema, zodPeerWarning } from "../src/codegen/generate.js";
import { atIndex } from "./helpers/manifest.js";

describe("codegen", () => {
	const outDir = join(
		import.meta.dirname,
		"../examples/blog/neoorm-test-out",
	);

	it("records the datasource provider and url in the manifest", async () => {
		await rm(outDir, { recursive: true, force: true });

		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		const { manifest } = await generateFromSchema(schemaPath, outDir, {
			provider: "sqlite",
			url: "./dev.db",
		});

		expect(manifest.provider).toBe("sqlite");
		expect(manifest.url).toBe("./dev.db");

		const manifestContent = await readFile(
			join(outDir, "manifest.ts"),
			"utf-8",
		);
		expect(manifestContent).toContain('"provider": "sqlite"');
		expect(manifestContent).toContain('"url": "./dev.db"');

		await rm(outDir, { recursive: true, force: true });
	});

	it("generates sqlite SQL when the provider is sqlite", async () => {
		await rm(outDir, { recursive: true, force: true });

		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		await generateFromSchema(schemaPath, outDir, {
			provider: "sqlite",
			url: "./dev.db",
		});

		const migrationsDir = join(outDir, "migrations");
		const migrationDirs = await readdir(migrationsDir);
		expect(migrationDirs.length).toBeGreaterThan(0);

		const migrationDir = join(migrationsDir, atIndex(migrationDirs, 0));
		const migrationSql = await readFile(
			join(migrationDir, "migration.sql"),
			"utf-8",
		);
		expect(migrationSql).toContain("CURRENT_TIMESTAMP");
		expect(migrationSql).not.toContain("NOW()");

		await rm(outDir, { recursive: true, force: true });
	});

	it("generates manifest and client from schema file", async () => {
		await rm(outDir, { recursive: true, force: true });

		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		const { manifest } = await generateFromSchema(schemaPath, outDir);

		expect(manifest.version).toBe(1);
		expect(manifest.tables.users).toBeDefined();

		const manifestContent = await readFile(
			join(outDir, "manifest.ts"),
			"utf-8",
		);
		expect(manifestContent).toContain('from "neoorm"');
		expect(manifestContent).toContain("export const manifest");

		const clientContent = await readFile(
			join(outDir, "client.ts"),
			"utf-8",
		);
		expect(clientContent).toContain('from "neoorm"');
		expect(clientContent).toContain("createNeoOrmClient");
		expect(clientContent).toContain("TypedNeoOrmClient");
		expect(clientContent).toContain("NeoOrmIncludes");

		const includesContent = await readFile(
			join(outDir, "includes.ts"),
			"utf-8",
		);
		expect(includesContent).toContain("export type UserWith");
		expect(includesContent).toContain("profile?:");
		expect(includesContent).toContain("_count?:");

		const modelsContent = await readFile(
			join(outDir, "models.ts"),
			"utf-8",
		);
		expect(modelsContent).toContain("export type User = {");
		expect(modelsContent).toContain("export type UserPayload =");
		expect(modelsContent).toContain("export type NeoOrmRowPayloads =");
		expect(modelsContent).toContain("createdAt: Date;");
		expect(modelsContent).not.toContain("createdAt: string");

		const migrationsDir = join(outDir, "migrations");
		const migrationDirs = await readdir(migrationsDir);
		if (migrationDirs.length > 0) {
			const migrationDir = join(migrationsDir, atIndex(migrationDirs, 0));
			const downSql = await readFile(
				join(migrationDir, "down.sql"),
				"utf-8",
			);
			expect(downSql.length).toBeGreaterThan(0);
			const snapshotBefore = await readFile(
				join(migrationDir, "snapshot.before.json"),
				"utf-8",
			);
			expect(JSON.parse(snapshotBefore)).toBeDefined();
		}

		await rm(outDir, { recursive: true, force: true });
	});

	it("does not write zod.ts by default", async () => {
		await rm(outDir, { recursive: true, force: true });
		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		await generateFromSchema(schemaPath, outDir);
		await expect(
			readFile(join(outDir, "zod.ts"), "utf-8"),
		).rejects.toMatchObject({ code: "ENOENT" });
		const clientContent = await readFile(
			join(outDir, "client.ts"),
			"utf-8",
		);
		expect(clientContent).not.toContain("./zod.js");
		await rm(outDir, { recursive: true, force: true });
	});

	it("writes zod.ts and re-exports it from client when zod is enabled", async () => {
		await rm(outDir, { recursive: true, force: true });
		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		const { warnings } = await generateFromSchema(schemaPath, outDir, {
			zod: true,
		});
		const zodContent = await readFile(join(outDir, "zod.ts"), "utf-8");
		expect(zodContent).toContain('import { z } from "zod";');
		expect(zodContent).toContain("export const UserCreateSchema");
		expect(zodContent).toContain("export type UserSelect");
		expect(zodContent).toContain("export type UserCreate");
		expect(zodContent).toContain("avatarUrl: z.url()");
		const clientContent = await readFile(
			join(outDir, "client.ts"),
			"utf-8",
		);
		expect(clientContent).toContain('export * from "./zod.js"');
		expect(
			warnings.some((warning) =>
				warning.includes('"zod" is not installed'),
			),
		).toBe(false);
		await generateFromSchema(schemaPath, outDir);
		await expect(
			readFile(join(outDir, "zod.ts"), "utf-8"),
		).rejects.toMatchObject({ code: "ENOENT" });
		await rm(outDir, { recursive: true, force: true });
	});
});

describe("zodPeerWarning", () => {
	it("is silent when zod can be resolved from the project", () => {
		expect(zodPeerWarning(process.cwd())).toBeUndefined();
	});

	it("warns when zod cannot be resolved", async () => {
		const dir = await mkdtemp(join(tmpdir(), "neoorm-no-zod-"));
		try {
			expect(zodPeerWarning(dir)).toBe(
				'generate.zod is enabled but "zod" is not installed. Run: bun add zod',
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
