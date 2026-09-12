import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../../codegen/schema-to-manifest.js";
import { sqliteDialect } from "../../dialect/sqlite.js";
import { defineSchema, fk, id, table, text } from "../../schema/index.js";
import { QueryErrorCode } from "../error-codes.js";
import { QueryCompileError, UniqueViolationError } from "../errors.js";
import { createSqliteExecutor } from "../executor.js";
import { createRecord } from "./create.js";
import { deleteRecord } from "./delete.js";
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

describe("splitScalarsAndRelationWrites invalid nested writes", () => {
	function postsTable() {
		const manifest = schemaToManifest(schema);
		return {
			manifest,
			table: requireTable(manifest, "posts", "select"),
			index: buildManifestIndex(manifest, sqliteDialect),
		};
	}

	function expectInvalidNestedWrite(data: Record<string, unknown>) {
		const { manifest, table, index } = postsTable();
		try {
			splitScalarsAndRelationWrites(
				manifest,
				"posts",
				table,
				data,
				index,
				"insert",
			);
			expect.unreachable("expected invalid_nested_write");
		} catch (err) {
			expect(err).toBeInstanceOf(QueryCompileError);
			expect((err as QueryCompileError).code).toBe(
				QueryErrorCode.invalid_nested_write,
			);
		}
	}

	it("throws when a relation object mixes write ops with extra keys", () => {
		expectInvalidNestedWrite({
			title: "Hello",
			author: { create: { email: "a@b.com", name: "Ada" }, foo: 1 },
		});
	});

	it("throws for empty objects, scalars, and unknown-only bags", () => {
		expectInvalidNestedWrite({ author: {} });
		expectInvalidNestedWrite({ author: 1 });
		expectInvalidNestedWrite({ author: { foo: 1 } });
	});

	it("accepts a pure nested create bag", () => {
		const { manifest, table, index } = postsTable();
		const split = splitScalarsAndRelationWrites(
			manifest,
			"posts",
			table,
			{
				title: "Hello",
				author: { create: { email: "a@b.com", name: "Ada" } },
			},
			index,
			"insert",
		);
		expect(split.scalarData).toEqual({ title: "Hello" });
		expect(split.relationWrites).toEqual([
			{
				relationName: "author",
				value: { create: { email: "a@b.com", name: "Ada" } },
			},
		]);
	});
});

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

describe("create rejects invalid nested relation writes", () => {
	it("does not insert the parent when the relation bag has extra keys", async () => {
		const { db, runtime, executor } = openDb();
		await expect(
			createRecord(executor, runtime, "posts", {
				data: {
					title: "orphan",
					author: {
						create: { email: "a@b.com", name: "Ada" },
						foo: 1,
					},
				},
			}),
		).rejects.toMatchObject({
			code: QueryErrorCode.invalid_nested_write,
		});
		const posts = await findMany(executor, runtime, "posts", {});
		expect(posts).toEqual([]);
		db.close();
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

describe("update/delete with relations", () => {
	it("returns full scalars when update sets with without returnUpdated", async () => {
		const { db, runtime, executor } = openDb();
		const author = await createRecord(executor, runtime, "users", {
			data: { email: "ada@b.com", name: "Ada" },
		});
		const post = await createRecord(executor, runtime, "posts", {
			data: { title: "one", authorId: author.id },
		});

		const updated = await updateRecord(executor, runtime, "posts", {
			where: { id: post.id },
			data: { title: "renamed" },
			with: { author: true },
		});
		expect(updated).toMatchObject({
			title: "renamed",
			author: { email: "ada@b.com", name: "Ada" },
		});
		db.close();
	});

	it("returns full scalars when delete sets with without returnDeleted", async () => {
		const { db, runtime, executor } = openDb();
		const author = await createRecord(executor, runtime, "users", {
			data: { email: "ada@b.com", name: "Ada" },
		});
		const post = await createRecord(executor, runtime, "posts", {
			data: { title: "one", authorId: author.id },
		});

		const deleted = await deleteRecord(executor, runtime, "posts", {
			where: { id: post.id },
			with: { author: true },
		});
		expect(deleted).toMatchObject({
			title: "one",
			author: { email: "ada@b.com", name: "Ada" },
		});
		db.close();
	});
});
