import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineSchema, fk, id, manyToMany, table, text } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { applyMigration } from "../src/migrate/runner.js";
import { sqliteClient } from "../src/runtime/driver.js";
import { QueryErrorCode, SchemaErrorCode } from "../src/runtime/error-codes.js";
import {
	formatSchemaError,
	NeoOrmDriverError,
	NeoOrmSchemaError,
} from "../src/runtime/errors.js";
import {
	enrichMigrationError,
	schemaCompileError,
} from "../src/runtime/schema-error.js";

const users = table({
	id: id(),
});

const posts = table({
	id: id(),
	authorId: fk(users).notNull(),
	title: text().notNull(),
	tags: manyToMany("tags"),
});

const tags = table({
	id: id(),
	slug: text().notNull().unique(),
});

const schema = defineSchema({ users, posts, tags });

describe("NeoOrmSchemaError", () => {
	it("formats schema path, table, migration file, detail, and SQL", () => {
		const message = formatSchemaError({
			code: SchemaErrorCode.migration_failed,
			schemaPath: "schema.ts",
			tableAccessor: "posts_tags",
			tableSqlName: "posts_tags",
			manyToManyHint: "auto junction for posts ↔ tags",
			migrationName: "20260902_migration",
			sqlPath: "neoorm/migrations/20260902_migration/migration.sql",
			detail: 'near "PRIMARY": syntax error',
			statement:
				'CREATE TABLE "posts_tags" (\n  PRIMARY KEY ("post_id", "tag_id")\n);',
		});

		expect(message).toContain("Schema error in schema.ts");
		expect(message).toContain("posts_tags");
		expect(message).toContain("auto junction for posts ↔ tags");
		expect(message).toContain('Migration "20260902_migration" failed');
		expect(message).toContain("migration.sql");
		expect(message).toContain('near "PRIMARY": syntax error');
		expect(message).toContain("CREATE TABLE");
	});

	it("wraps schema compile failures with the schema path", () => {
		const err = schemaCompileError(
			"schema.ts",
			'Table "x" has no primary key.',
		);
		expect(err).toBeInstanceOf(NeoOrmSchemaError);
		expect(err.message).toContain("Schema error in schema.ts");
		expect(err.message).toContain('Table "x" has no primary key.');
	});

	it("enriches migration failures with manifest table context", async () => {
		const manifest = schemaToManifest(schema);
		const migrationsDir = join(
			import.meta.dirname,
			".schema-error-migrations",
		);
		const migrationName = "bad_migration";
		const migrationDir = join(migrationsDir, migrationName);
		await mkdir(migrationDir, { recursive: true });
		await writeFile(
			join(migrationDir, "migration.sql"),
			`CREATE TABLE "posts_tags" (
  PRIMARY KEY ("post_id", "tag_id")
);`,
			"utf-8",
		);

		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);

		try {
			await applyMigration(
				client,
				sqliteDialect,
				migrationsDir,
				migrationName,
				{
					manifest,
					schemaPath: "schema.ts",
				},
			);
			expect.fail("expected migration to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(NeoOrmSchemaError);
			const schemaErr = err as NeoOrmSchemaError;
			expect(schemaErr.message).toContain("Schema error in schema.ts");
			expect(schemaErr.message).toContain("posts_tags");
			expect(schemaErr.message).toContain(
				"auto junction for posts ↔ tags",
			);
			expect(schemaErr.message).toContain("bad_migration");
			expect(schemaErr.message).toContain("migration.sql");
			expect(schemaErr.message).toContain("PRIMARY");
			expect(schemaErr.message).toContain("CREATE TABLE");
		} finally {
			await client.close();
		}
	});

	it("maps driver errors to schema errors via enrichMigrationError", () => {
		const manifest = schemaToManifest(schema);
		const driverErr = enrichMigrationError(
			new NeoOrmDriverError(
				'CREATE TABLE "posts_tags" (\n  PRIMARY KEY ("post_id", "tag_id")\n);',
				new Error('near "PRIMARY": syntax error'),
			),
			{
				schemaPath: "schema.ts",
				manifest,
				migrationName: "bad_migration",
				sqlPath: "neoorm/migrations/bad_migration/migration.sql",
			},
		);

		expect(driverErr.message).toContain("posts_tags");
		expect(driverErr.message).toContain('near "PRIMARY": syntax error');
	});
});
