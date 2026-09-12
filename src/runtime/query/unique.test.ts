import { describe, expect, it } from "vitest";
import { emptyManifest } from "../../codegen/diff-manifest.js";
import type { ManifestColumn, ManifestTable } from "../../dialect/types.js";
import { QueryErrorCode } from "../error-codes.js";
import { QueryCompileError } from "../errors.js";
import type { Executor } from "../executor.js";
import { deleteRecord } from "./delete.js";
import type { QueryRuntime } from "./execute.js";
import { buildManifestIndex } from "./table-index.js";
import { assertUniqueWhere, resolveUniqueConstraint } from "./unique.js";
import { updateRecord } from "./update.js";

function column(
	tsName: string,
	options: Partial<ManifestColumn> = {},
): ManifestColumn {
	return {
		tsName,
		sqlName: options.sqlName ?? tsName,
		kind: options.kind ?? "text",
		primary: options.primary ?? false,
		unique: options.unique ?? false,
		nullable: options.nullable ?? false,
		defaultNow: options.defaultNow ?? false,
	};
}

function postsTable(): ManifestTable {
	return {
		accessor: "posts",
		sqlName: "posts",
		primaryKey: ["id"],
		columns: [
			column("id", { kind: "id", primary: true }),
			column("published", { kind: "bool" }),
			column("slug", { unique: true }),
			column("authorId", { sqlName: "author_id", kind: "fk" }),
		],
		indexes: [
			{
				name: "posts_author_slug_key",
				columns: ["author_id", "slug"],
				unique: true,
			},
		],
		relations: [],
	};
}

function postsRuntime(): QueryRuntime {
	const manifest = emptyManifest();
	manifest.tables.posts = postsTable();
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest),
	};
}

function failingExecutor(): Executor {
	const fail = async (): Promise<never> => {
		throw new Error("executor should not be called");
	};
	return {
		query: fail,
		queryOne: fail,
		execute: fail,
		transaction: async (fn) => fn(failingExecutor()),
	};
}

describe("resolveUniqueConstraint", () => {
	const table = postsTable();

	it("matches a primary key where", () => {
		expect(resolveUniqueConstraint(table, { id: "post_1" })).toEqual({
			sqlColumns: ["id"],
			tsKeys: ["id"],
		});
	});

	it("matches a @unique column where", () => {
		expect(resolveUniqueConstraint(table, { slug: "hello" })).toEqual({
			sqlColumns: ["slug"],
			tsKeys: ["slug"],
		});
	});

	it("matches a composite unique index", () => {
		expect(
			resolveUniqueConstraint(table, {
				authorId: "user_1",
				slug: "hello",
			}),
		).toEqual({
			sqlColumns: ["author_id", "slug"],
			tsKeys: ["authorId", "slug"],
		});
	});

	it("rejects a non-unique filter", () => {
		expect(resolveUniqueConstraint(table, { published: true })).toBeNull();
	});
});

describe("assertUniqueWhere", () => {
	const table = postsTable();

	it("records the caller operation on unique_where_invalid", () => {
		try {
			assertUniqueWhere(table, { published: true }, "delete");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(QueryCompileError);
			const compileErr = err as QueryCompileError;
			expect(compileErr.code).toBe(QueryErrorCode.unique_where_invalid);
			expect(compileErr.context.operation).toBe("delete");
		}
	});
});

describe("singular update/delete unique where", () => {
	it("update rejects a non-unique where without querying", async () => {
		await expect(
			updateRecord(failingExecutor(), postsRuntime(), "posts", {
				where: { published: true },
				data: { slug: "changed" },
			}),
		).rejects.toMatchObject({
			code: QueryErrorCode.unique_where_invalid,
			context: { operation: "update" },
		});
	});

	it("delete rejects a non-unique where without querying", async () => {
		await expect(
			deleteRecord(failingExecutor(), postsRuntime(), "posts", {
				where: { published: true },
			}),
		).rejects.toMatchObject({
			code: QueryErrorCode.unique_where_invalid,
			context: { operation: "delete" },
		});
	});

	it("update accepts a primary-key where and runs the mutation", async () => {
		let executed = false;
		const executor: Executor = {
			query: async () => [],
			queryOne: async () => null,
			execute: async () => {
				executed = true;
				return { rows: [], rowCount: 0 };
			},
			transaction: async (fn) => fn(executor),
		};
		const result = await updateRecord(executor, postsRuntime(), "posts", {
			where: { id: "post_1" },
			data: { published: true },
		});
		expect(result).toBeNull();
		expect(executed).toBe(true);
	});
});
