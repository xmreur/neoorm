import { describe, expect, it } from "vitest";
import { emptyManifest } from "../../codegen/diff-manifest.js";
import type { ManifestColumn, ManifestTable } from "../../dialect/types.js";
import { QueryErrorCode } from "../error-codes.js";
import { QueryCompileError } from "../errors.js";
import type { Executor } from "../executor.js";
import { FIND_OR_CREATE_FLAG } from "./compile.js";
import { findUnique } from "./count.js";
import { deleteRecord } from "./delete.js";
import type { QueryRuntime } from "./execute.js";
import { findOrCreateRecord } from "./find-or-create.js";
import { buildManifestIndex } from "./table-index.js";
import {
	assertUniqueWhere,
	assertUniqueWhereWithExtra,
	resolveUniqueConstraint,
	tryPkEqualityValues,
} from "./unique.js";
import { updateRecord } from "./update.js";
import { upsertRecord } from "./upsert.js";

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

describe("tryPkEqualityValues", () => {
	const table = postsTable();

	it("returns PK bind values for scalar and equals where", () => {
		expect(tryPkEqualityValues(table, { id: "post_1" })).toEqual([
			"post_1",
		]);
		expect(
			tryPkEqualityValues(table, { id: { equals: "post_1" } }),
		).toEqual(["post_1"]);
	});

	it("rejects unique-not-PK and non-equality operators", () => {
		expect(tryPkEqualityValues(table, { slug: "hello" })).toBeNull();
		expect(
			tryPkEqualityValues(table, { id: { contains: "post" } }),
		).toBeNull();
		expect(
			tryPkEqualityValues(table, { id: "post_1", slug: "hello" }),
		).toBeNull();
	});
});

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

	it("matches a partial unique index", () => {
		const table: ManifestTable = {
			...postsTable(),
			columns: postsTable().columns.map((col) =>
				col.tsName === "slug" ? { ...col, unique: false } : col,
			),
			indexes: [
				{
					name: "email",
					columns: ["slug"],
					unique: true,
					whereSql: '"published" = true',
				},
			],
		};
		expect(resolveUniqueConstraint(table, { slug: "hello" })).toEqual({
			sqlColumns: ["slug"],
			tsKeys: ["slug"],
			whereSql: '"published" = true',
		});
	});

	it("prefers a non-partial unique index over a partial unique on the same columns", () => {
		const table: ManifestTable = {
			...postsTable(),
			columns: postsTable().columns.map((col) =>
				col.tsName === "slug" ? { ...col, unique: false } : col,
			),
			indexes: [
				{
					name: "slug_published",
					columns: ["slug"],
					unique: true,
					whereSql: '"published" = true',
				},
				{
					name: "slug_key",
					columns: ["slug"],
					unique: true,
				},
			],
		};
		expect(resolveUniqueConstraint(table, { slug: "hello" })).toEqual({
			sqlColumns: ["slug"],
			tsKeys: ["slug"],
		});
	});

	it("rejects a non-unique filter", () => {
		expect(resolveUniqueConstraint(table, { published: true })).toBeNull();
	});

	it("does not treat an expression unique index as a findUnique target", () => {
		const table: ManifestTable = {
			...postsTable(),
			columns: postsTable().columns.map((col) =>
				col.tsName === "slug" ? { ...col, unique: false } : col,
			),
			indexes: [
				{
					name: "slug_lower",
					columns: [],
					unique: true,
					keys: [{ expr: "lower(slug)" }],
				},
			],
		};
		expect(resolveUniqueConstraint(table, { slug: "hello" })).toBeNull();
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

	it("unwraps { equals } operator objects to scalars", () => {
		expect(
			assertUniqueWhere(table, { slug: { equals: "hello" } }, "upsert"),
		).toEqual({
			constraint: { sqlColumns: ["slug"], tsKeys: ["slug"] },
			where: { slug: "hello" },
		});
	});

	it("unwraps { equals, mode: default }", () => {
		expect(
			assertUniqueWhere(
				table,
				{ slug: { equals: "hello", mode: "default" } },
				"findUnique",
			).where,
		).toEqual({ slug: "hello" });
	});

	it("keeps JSON-shaped objects that are not operators", () => {
		expect(
			assertUniqueWhere(table, { slug: { featured: true } }, "findUnique")
				.where,
		).toEqual({ slug: { featured: true } });
	});

	it("rejects contains operators on unique where", () => {
		try {
			assertUniqueWhere(table, { slug: { contains: "hel" } }, "upsert");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(QueryCompileError);
			const compileErr = err as QueryCompileError;
			expect(compileErr.code).toBe(QueryErrorCode.unique_where_invalid);
			expect(compileErr.message).toContain("scalar equality");
			expect(compileErr.context.operation).toBe("upsert");
			expect(compileErr.context.columnTsName).toBe("slug");
		}
	});

	it("rejects mode: insensitive on unique where", () => {
		expect(() =>
			assertUniqueWhere(
				table,
				{ slug: { equals: "hello", mode: "insensitive" } },
				"findOrCreate",
			),
		).toThrow(QueryCompileError);
	});
});

function capturingExecutor(): {
	executor: Executor;
	params: unknown[];
	sql: string[];
} {
	const captured: { params: unknown[]; sql: string[] } = {
		params: [],
		sql: [],
	};
	const executor: Executor = {
		query: async (sql: string, params?: unknown[]) => {
			captured.sql.push(sql);
			captured.params.splice(
				0,
				captured.params.length,
				...(params ?? []),
			);
			return [];
		},
		queryOne: async <T = Record<string, unknown>>(
			sql: string,
			params?: unknown[],
		) => {
			captured.sql.push(sql);
			captured.params.splice(
				0,
				captured.params.length,
				...(params ?? []),
			);
			return {
				id: "post_1",
				published: false,
				slug: "hello",
				author_id: null,
				[FIND_OR_CREATE_FLAG]: true,
			} as T;
		},
		execute: async (sql: string) => {
			captured.sql.push(sql);
			return { rows: [], rowCount: 0 };
		},
		transaction: async (fn) => fn(executor),
	};
	return { executor, params: captured.params, sql: captured.sql };
}

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

describe("upsert/findOrCreate unique where scalars", () => {
	it("upsert merges unwrapped unique where into INSERT values", async () => {
		const { executor, params } = capturingExecutor();
		await upsertRecord(executor, postsRuntime(), "posts", {
			where: { slug: { equals: "hello" } },
			create: { published: false },
			update: { published: true },
		});
		expect(params).toContain("hello");
		expect(
			params.some(
				(value) =>
					typeof value === "object" &&
					value !== null &&
					Object.hasOwn(value, "equals"),
			),
		).toBe(false);
	});

	it("findOrCreate merges unwrapped unique where into INSERT values", async () => {
		const { executor, params } = capturingExecutor();
		await findOrCreateRecord(executor, postsRuntime(), "posts", {
			where: { slug: { equals: "hello" } },
			create: { published: false },
		});
		expect(params).toContain("hello");
		expect(
			params.some(
				(value) =>
					typeof value === "object" &&
					value !== null &&
					Object.hasOwn(value, "equals"),
			),
		).toBe(false);
	});
});

function partialSlugPostsTable(): ManifestTable {
	return {
		...postsTable(),
		columns: postsTable().columns.map((col) =>
			col.tsName === "slug" ? { ...col, unique: false } : col,
		),
		indexes: [
			{
				name: "posts_slug_published_key",
				columns: ["slug"],
				unique: true,
				whereSql: '"published" = true',
			},
		],
	};
}

function partialSlugPostsRuntime(): QueryRuntime {
	const manifest = emptyManifest();
	manifest.tables.posts = partialSlugPostsTable();
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest),
	};
}

describe("partial unique index targets", () => {
	it("findUnique ANDs the index predicate", async () => {
		const { executor, sql } = capturingExecutor();
		await findUnique(executor, partialSlugPostsRuntime(), "posts", {
			where: { slug: "hello" },
		});
		expect(sql[0]).toContain('"slug" = $1');
		expect(sql[0]).toContain('("published" = true)');
	});

	it("upsert uses ON CONFLICT WHERE the index predicate", async () => {
		const { executor, sql } = capturingExecutor();
		await upsertRecord(executor, partialSlugPostsRuntime(), "posts", {
			where: { slug: "hello" },
			create: { published: true },
			update: { published: true },
		});
		expect(sql[0]).toContain(
			'ON CONFLICT ("slug") WHERE "published" = true DO UPDATE SET',
		);
	});

	it("findOrCreate uses ON CONFLICT WHERE the index predicate", async () => {
		const { executor, sql } = capturingExecutor();
		await findOrCreateRecord(executor, partialSlugPostsRuntime(), "posts", {
			where: { slug: "hello" },
			create: { published: true },
		});
		expect(sql[0]).toContain(
			'ON CONFLICT ("slug") WHERE "published" = true DO UPDATE SET',
		);
	});
});

describe("assertUniqueWhereWithExtra", () => {
	const table = postsTable();

	it("picks the longest composite subset and keeps leftover scalars as extra", () => {
		const asserted = assertUniqueWhereWithExtra(
			table,
			{ slug: "hello", authorId: "user_1", published: true },
			"update",
		);
		expect(asserted.constraint).toEqual({
			sqlColumns: ["author_id", "slug"],
			tsKeys: ["authorId", "slug"],
		});
		expect(asserted.uniqueWhere).toEqual({
			slug: "hello",
			authorId: "user_1",
		});
		expect(asserted.extraWhere).toEqual({ published: true });
		expect(asserted.where).toEqual({
			slug: "hello",
			authorId: "user_1",
			published: true,
		});
	});

	it("keeps operator filters as extra without unwrapping", () => {
		const asserted = assertUniqueWhereWithExtra(
			table,
			{ slug: "hello", published: { isNull: true } },
			"update",
		);
		expect(asserted.constraint).toEqual({
			sqlColumns: ["slug"],
			tsKeys: ["slug"],
		});
		expect(asserted.uniqueWhere).toEqual({ slug: "hello" });
		expect(asserted.extraWhere).toEqual({
			published: { isNull: true },
		});
	});

	it("passes AND/OR/NOT through as extra", () => {
		const asserted = assertUniqueWhereWithExtra(
			table,
			{ slug: "hello", AND: [{ published: true }] },
			"delete",
		);
		expect(asserted.uniqueWhere).toEqual({ slug: "hello" });
		expect(asserted.extraWhere).toEqual({
			AND: [{ published: true }],
		});
	});

	it("unwraps { equals } on the unique field", () => {
		const asserted = assertUniqueWhereWithExtra(
			table,
			{ slug: { equals: "hello" }, published: true },
			"update",
		);
		expect(asserted.uniqueWhere).toEqual({ slug: "hello" });
		expect(asserted.extraWhere).toEqual({ published: true });
	});

	it("prefers the primary key on equal-length ties", () => {
		const asserted = assertUniqueWhereWithExtra(
			table,
			{ id: "post_1", slug: "hello" },
			"update",
		);
		expect(asserted.constraint).toEqual({
			sqlColumns: ["id"],
			tsKeys: ["id"],
		});
		expect(asserted.uniqueWhere).toEqual({ id: "post_1" });
		expect(asserted.extraWhere).toEqual({ slug: "hello" });
	});

	it("rejects a where with no unique subset", () => {
		expect(() =>
			assertUniqueWhereWithExtra(table, { published: true }, "update"),
		).toThrow(
			expect.objectContaining({
				code: QueryErrorCode.unique_where_invalid,
			}),
		);
	});

	it("rejects an operator on the only unique field", () => {
		expect(() =>
			assertUniqueWhereWithExtra(
				table,
				{ slug: { contains: "hel" } },
				"update",
			),
		).toThrow(
			expect.objectContaining({
				code: QueryErrorCode.unique_where_invalid,
			}),
		);
	});
});

function rowCountExecutor(rowCount: number): {
	executor: Executor;
	sql: string[];
} {
	const sql: string[] = [];
	const executor: Executor = {
		query: async (query: string) => {
			sql.push(query);
			return [];
		},
		queryOne: async (query: string) => {
			sql.push(query);
			return null;
		},
		execute: async (query: string) => {
			sql.push(query);
			return { rows: [], rowCount };
		},
		transaction: async (fn) => fn(executor),
	};
	return { executor, sql };
}

describe("singular update/delete with extra AND filter", () => {
	it("update ANDs the extra predicate into SQL", async () => {
		const { executor, sql } = rowCountExecutor(1);
		const result = await updateRecord(executor, postsRuntime(), "posts", {
			where: { slug: "hello", published: true },
			data: { published: false },
		});
		expect(result).toEqual({});
		expect(sql[0]).toContain('"slug"');
		expect(sql[0]).toContain('"published"');
	});

	it("update returns null when the extra predicate matches 0 rows", async () => {
		const { executor, sql } = rowCountExecutor(0);
		const result = await updateRecord(executor, postsRuntime(), "posts", {
			where: { slug: "hello", published: { isNull: true } },
			data: { published: false },
		});
		expect(result).toBeNull();
		expect(sql[0]).toContain('"slug"');
	});

	it("update keeps exact unique-only where working", async () => {
		const { executor, sql } = rowCountExecutor(1);
		const result = await updateRecord(executor, postsRuntime(), "posts", {
			where: { slug: "hello" },
			data: { published: true },
		});
		expect(result).toEqual({});
		expect(sql[0]).toContain('"slug"');
	});

	it("update with PK plus extra does not use the extra-dropping fast path", async () => {
		const { executor, sql } = rowCountExecutor(1);
		const result = await updateRecord(executor, postsRuntime(), "posts", {
			where: { id: "post_1", slug: "hello" },
			data: { published: true },
		});
		expect(result).toEqual({});
		expect(sql[0]).toContain('"id"');
		expect(sql[0]).toContain('"slug"');
	});

	it("delete ANDs the extra predicate and returns null on 0 rows", async () => {
		const { executor: hitExecutor, sql: hitSql } = rowCountExecutor(1);
		const hit = await deleteRecord(hitExecutor, postsRuntime(), "posts", {
			where: { slug: "hello", published: true },
		});
		expect(hit).toEqual({});
		expect(hitSql[0]).toContain('"slug"');
		expect(hitSql[0]).toContain('"published"');

		const { executor: missExecutor } = rowCountExecutor(0);
		const miss = await deleteRecord(missExecutor, postsRuntime(), "posts", {
			where: { slug: "hello", published: true },
		});
		expect(miss).toBeNull();
	});

	it("update still rejects a where with no unique subset", async () => {
		await expect(
			updateRecord(failingExecutor(), postsRuntime(), "posts", {
				where: { published: true },
				data: { slug: "changed" },
			}),
		).rejects.toMatchObject({
			code: QueryErrorCode.unique_where_invalid,
		});
	});
});
