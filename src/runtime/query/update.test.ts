import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../../codegen/schema-to-manifest.js";
import { sqliteDialect } from "../../dialect/sqlite.js";
import { defineSchema, fk, id, table, text } from "../../schema/index.js";
import { UniqueViolationError } from "../errors.js";
import { createSqliteExecutor } from "../executor.js";
import { createRecord } from "./create.js";
import type { QueryRuntime } from "./execute.js";
import { findMany } from "./find.js";
import {
	relationWritesNeedTransaction,
	splitScalarsAndRelationWrites,
} from "./relation-writes.js";
import { buildManifestIndex, requireTable } from "./table-index.js";
import { updateRecord } from "./update.js";

const schema = defineSchema({
	users: table({
		id: id(),
		email: text().notNull().unique(),
		name: text().notNull(),
	}),
	posts: table({
		id: id(),
		title: text().notNull().unique(),
		authorId: fk("users").notNull(),
	}),
});

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

describe("relationWritesNeedTransaction", () => {
	it("is true for nested to-one create on update", () => {
		const manifest = schemaToManifest(schema);
		const table = requireTable(manifest, "posts", "select");
		const split = splitScalarsAndRelationWrites(
			manifest,
			"posts",
			table,
			{
				title: "Hello",
				author: { create: { email: "a@b.com", name: "Ada" } },
			},
			buildManifestIndex(manifest, sqliteDialect),
			"update",
		);
		expect(
			relationWritesNeedTransaction(
				table,
				manifest,
				"posts",
				split.relationWrites,
			),
		).toBe(true);
	});

	it("is false for to-one connect", () => {
		const manifest = schemaToManifest(schema);
		const table = requireTable(manifest, "posts", "select");
		const split = splitScalarsAndRelationWrites(
			manifest,
			"posts",
			table,
			{ author: { connect: { id: "user_1" } } },
			buildManifestIndex(manifest, sqliteDialect),
			"update",
		);
		expect(
			relationWritesNeedTransaction(
				table,
				manifest,
				"posts",
				split.relationWrites,
			),
		).toBe(false);
	});
});

describe("update nested to-one create", () => {
	it("rolls back a nested author create when the parent update fails", async () => {
		const { db, runtime, executor } = openDb();
		const author = await createRecord(executor, runtime, "users", {
			data: { email: "ada@b.com", name: "Ada" },
		});
		const post = await createRecord(executor, runtime, "posts", {
			data: { title: "one", authorId: author.id },
		});
		await createRecord(executor, runtime, "posts", {
			data: { title: "two", authorId: author.id },
		});

		await expect(
			updateRecord(executor, runtime, "posts", {
				where: { id: post.id },
				data: {
					title: "two",
					author: {
						create: { email: "grace@b.com", name: "Grace" },
					},
				},
			}),
		).rejects.toBeInstanceOf(UniqueViolationError);

		const users = await findMany(executor, runtime, "users", {});
		expect(users.map((row) => row.email).sort()).toEqual(["ada@b.com"]);
		db.close();
	});
});
