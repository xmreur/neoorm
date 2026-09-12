import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../../codegen/schema-to-manifest.js";
import { sqliteDialect } from "../../dialect/sqlite.js";
import { defineSchema, fk, id, table, text } from "../../schema/index.js";
import {
	ForeignKeyViolationError,
	NotNullViolationError,
	UniqueViolationError,
} from "../errors.js";
import { createSqliteExecutor } from "../executor.js";
import { createRecord } from "./create.js";
import type { QueryRuntime } from "./execute.js";
import { buildManifestIndex, requireTable } from "./table-index.js";

const schema = defineSchema({
	users: table({
		id: id(),
		email: text().notNull().unique(),
		name: text().notNull(),
	}),
	posts: table({
		id: id(),
		title: text().notNull(),
		authorId: fk("users").notNull(),
	}),
});

describe("SQLite constraint errors", () => {
	function openDb() {
		const db = new DatabaseSync(":memory:");
		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = {
			manifest,
			tableIndex: buildManifestIndex(manifest, sqliteDialect),
			dialect: sqliteDialect,
		};
		db.exec(
			sqliteDialect.emitCreateTable(
				requireTable(manifest, "users", "select"),
				{ manifest },
			),
		);
		db.exec(
			sqliteDialect.emitCreateTable(
				requireTable(manifest, "posts", "select"),
				{ manifest },
			),
		);
		return { db, runtime, executor: createSqliteExecutor(db) };
	}

	it("maps unique failures to UniqueViolationError", async () => {
		const { db, runtime, executor } = openDb();
		await createRecord(executor, runtime, "users", {
			data: { email: "a@b.com", name: "Ada" },
		});
		await expect(
			createRecord(executor, runtime, "users", {
				data: { email: "a@b.com", name: "Grace" },
			}),
		).rejects.toBeInstanceOf(UniqueViolationError);
		db.close();
	});

	it("maps NOT NULL failures to NotNullViolationError", async () => {
		const { db, runtime, executor } = openDb();
		await expect(
			createRecord(executor, runtime, "users", {
				data: { email: "a@b.com" },
			}),
		).rejects.toBeInstanceOf(NotNullViolationError);
		db.close();
	});

	it("maps foreign key failures to ForeignKeyViolationError", async () => {
		const { db, runtime, executor } = openDb();
		await expect(
			createRecord(executor, runtime, "posts", {
				data: { title: "Hello", authorId: "missing" },
			}),
		).rejects.toBeInstanceOf(ForeignKeyViolationError);
		db.close();
	});
});
