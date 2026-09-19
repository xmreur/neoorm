import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	elysiaPeerWarning,
	generateFromSchema,
	typeboxPeerWarning,
	zodPeerWarning,
} from "../src/codegen/generate.js";
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
		expect(clientContent).toContain("NeoOrmClient");
		expect(clientContent).toContain("./query-types.js");
		expect(clientContent).not.toContain("TypedNeoOrmClient");
		expect(clientContent).not.toContain("schema._tables");
		expect(clientContent).not.toContain("TableDef");
		expect(clientContent).not.toContain("ColumnBuilder");

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
		expect(modelsContent).toContain("export interface User {");
		expect(modelsContent).toContain("export type PostStatus =");
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

	it("does not write zod.ts, typebox.ts, or elysia.ts by default", async () => {
		await rm(outDir, { recursive: true, force: true });
		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		await generateFromSchema(schemaPath, outDir);
		await expect(
			readFile(join(outDir, "zod.ts"), "utf-8"),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			readFile(join(outDir, "typebox.ts"), "utf-8"),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			readFile(join(outDir, "elysia.ts"), "utf-8"),
		).rejects.toMatchObject({ code: "ENOENT" });
		const clientContent = await readFile(
			join(outDir, "client.ts"),
			"utf-8",
		);
		expect(clientContent).not.toContain("./zod.js");
		expect(clientContent).not.toContain("./typebox.js");
		expect(clientContent).not.toContain("./elysia.js");
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

	it("writes typebox.ts and re-exports it from client when typebox is enabled", async () => {
		await rm(outDir, { recursive: true, force: true });
		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		const { warnings } = await generateFromSchema(schemaPath, outDir, {
			typebox: true,
		});
		const typeboxContent = await readFile(
			join(outDir, "typebox.ts"),
			"utf-8",
		);
		expect(typeboxContent).toContain('import Type from "typebox";');
		expect(typeboxContent).toContain("export const UserCreateSchema");
		expect(typeboxContent).toContain("export type UserSelect");
		expect(typeboxContent).toContain("export type UserCreate");
		expect(typeboxContent).toContain(
			'avatarUrl: Type.Union([Type.String({ format: "url" }), Type.Null()])',
		);
		const clientContent = await readFile(
			join(outDir, "client.ts"),
			"utf-8",
		);
		expect(clientContent).toContain('export * from "./typebox.js"');
		expect(clientContent).not.toContain("./zod.js");
		expect(
			warnings.some((warning) =>
				warning.includes('"typebox" is not installed'),
			),
		).toBe(false);
		await generateFromSchema(schemaPath, outDir);
		await expect(
			readFile(join(outDir, "typebox.ts"), "utf-8"),
		).rejects.toMatchObject({ code: "ENOENT" });
		await rm(outDir, { recursive: true, force: true });
	});

	it("namespaces TypeBox exports when both printers are enabled", async () => {
		await rm(outDir, { recursive: true, force: true });
		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		await generateFromSchema(schemaPath, outDir, {
			zod: true,
			typebox: true,
		});
		const clientContent = await readFile(
			join(outDir, "client.ts"),
			"utf-8",
		);
		expect(clientContent).toContain('export * from "./zod.js"');
		expect(clientContent).toContain(
			'export * as typebox from "./typebox.js"',
		);
		await expect(
			readFile(join(outDir, "zod.ts"), "utf-8"),
		).resolves.toContain("export const UserCreateSchema");
		await expect(
			readFile(join(outDir, "typebox.ts"), "utf-8"),
		).resolves.toContain("export const UserCreateSchema");
		await rm(outDir, { recursive: true, force: true });
	});

	it("writes elysia.ts and re-exports it from client when elysia is enabled", async () => {
		await rm(outDir, { recursive: true, force: true });
		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		const { warnings } = await generateFromSchema(schemaPath, outDir, {
			elysia: true,
		});
		const elysiaContent = await readFile(
			join(outDir, "elysia.ts"),
			"utf-8",
		);
		expect(elysiaContent).toContain('import { t } from "elysia";');
		expect(elysiaContent).toContain("export const UserCreateSchema");
		expect(elysiaContent).toContain("export type UserSelect");
		expect(elysiaContent).toContain("export type UserCreate");
		expect(elysiaContent).toContain(
			'avatarUrl: t.Nullable(t.String({ format: "uri" }))',
		);
		const clientContent = await readFile(
			join(outDir, "client.ts"),
			"utf-8",
		);
		expect(clientContent).toContain('export * from "./elysia.js"');
		expect(clientContent).not.toContain("./zod.js");
		expect(clientContent).not.toContain("./typebox.js");
		expect(
			warnings.some((warning) =>
				warning.includes('"elysia" is not installed'),
			),
		).toBe(true);
		await generateFromSchema(schemaPath, outDir);
		await expect(
			readFile(join(outDir, "elysia.ts"), "utf-8"),
		).rejects.toMatchObject({ code: "ENOENT" });
		await rm(outDir, { recursive: true, force: true });
	});

	it("namespaces Elysia exports when Zod is also enabled", async () => {
		await rm(outDir, { recursive: true, force: true });
		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		await generateFromSchema(schemaPath, outDir, {
			zod: true,
			elysia: true,
		});
		const clientContent = await readFile(
			join(outDir, "client.ts"),
			"utf-8",
		);
		expect(clientContent).toContain('export * from "./zod.js"');
		expect(clientContent).toContain(
			'export * as elysia from "./elysia.js"',
		);
		await expect(
			readFile(join(outDir, "elysia.ts"), "utf-8"),
		).resolves.toContain("export const UserCreateSchema");
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

describe("typeboxPeerWarning", () => {
	it("is silent when typebox can be resolved from the project", () => {
		expect(typeboxPeerWarning(process.cwd())).toBeUndefined();
	});

	it("warns when typebox cannot be resolved", async () => {
		const dir = await mkdtemp(join(tmpdir(), "neoorm-no-typebox-"));
		try {
			expect(typeboxPeerWarning(dir)).toBe(
				'generate.typebox is enabled but "typebox" is not installed. Run: bun add typebox',
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("elysiaPeerWarning", () => {
	it("warns when elysia cannot be resolved from the project", () => {
		expect(elysiaPeerWarning(process.cwd())).toBe(
			'generate.elysia is enabled but "elysia" is not installed. Run: bun add elysia',
		);
	});

	it("warns when elysia cannot be resolved from an empty dir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "neoorm-no-elysia-"));
		try {
			expect(elysiaPeerWarning(dir)).toBe(
				'generate.elysia is enabled but "elysia" is not installed. Run: bun add elysia',
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
