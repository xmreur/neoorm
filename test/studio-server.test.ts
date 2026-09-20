import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import type { Manifest } from "../src/dialect/types.js";
import { dbPush } from "../src/migrate/runner.js";
import {
	type SqliteDatabaseLike,
	sqliteClient,
} from "../src/runtime/driver.js";
import {
	defineSchema,
	fk,
	index,
	int,
	manyToMany,
	primaryKey,
	serial,
	table,
	text,
} from "../src/schema/index.js";
import {
	decodeStudioData,
	decodeStudioValue,
	encodeStudioRow,
} from "../src/studio/codec.js";
import { parseCsv, toCsv } from "../src/studio/csv.js";
import type { toStudioGraph } from "../src/studio/graph.js";
import { toStudioMeta } from "../src/studio/meta.js";
import { type StudioServer, startStudioServer } from "../src/studio/server.js";

const schema = defineSchema({
	users: table({
		id: serial().primary(),
		email: text().notNull().unique(),
		name: text(),
		password: text().hidden(),
		age: int(),
	}),
	posts: table(
		"posts",
		{
			id: serial().primary(),
			title: text().notNull(),
			authorId: fk("users.id").as("author").inverse("posts").notNull(),
			tags: manyToMany("tags", { through: "posts_tags" }),
		},
		(t) => [index(t.title)],
	),
	tags: table({
		id: serial().primary(),
		slug: text().notNull().unique(),
	}),
	posts_tags: table(
		"post_tags",
		{
			postId: fk("posts.id").as("post").inverse("posts_tags").notNull(),
			tagId: fk("tags.id").as("tag").inverse("posts_tags").notNull(),
		},
		(t) => [primaryKey(t.postId, t.tagId)],
	),
});

const SECRET_URL = "sqlite://secret-do-not-expose";
const manifest: Manifest = schemaToManifest(schema, [], {
	provider: "sqlite",
	url: SECRET_URL,
});

let db: SqliteDatabaseLike;
let server: StudioServer;
let readOnlyServer: StudioServer;
let tokenServer: StudioServer;
let migrationsDir: string;

async function api(
	path: string,
	init?: RequestInit,
	base?: StudioServer,
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(`${(base ?? server).url}${path}`, init);
	const contentType = res.headers.get("content-type") ?? "";
	const body = contentType.includes("application/json")
		? await res.json()
		: await res.text();
	return { status: res.status, body };
}

function post(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

function patch(body: unknown): RequestInit {
	return {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

function del(body: unknown): RequestInit {
	return {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

beforeAll(async () => {
	db = new DatabaseSync(":memory:");
	await dbPush(sqliteClient(db), sqliteDialect, manifest);
	migrationsDir = mkdtempSync(join(tmpdir(), "studio-migrations-"));
	server = await startStudioServer({
		port: 0,
		manifest,
		sqliteDb: db,
		provider: "sqlite",
		version: "test",
		migrationsDir,
	});
	readOnlyServer = await startStudioServer({
		port: 0,
		manifest,
		sqliteDb: db,
		provider: "sqlite",
		version: "test",
		readOnly: true,
	});
	tokenServer = await startStudioServer({
		port: 0,
		manifest,
		sqliteDb: db,
		provider: "sqlite",
		version: "test",
		token: "studio-secret",
	});
});

afterAll(async () => {
	await server.close();
	await readOnlyServer.close();
	await tokenServer.close();
	db.close();
});

describe("studio meta", () => {
	it("strips the datasource url and marks hidden columns", async () => {
		const { status, body } = await api("/api/meta");
		expect(status).toBe(200);
		expect(JSON.stringify(body)).not.toContain("secret-do-not-expose");
		const meta = body as ReturnType<typeof toStudioMeta> & {
			readOnly: boolean;
			dialect: string;
		};
		expect(meta.dialect).toBe("sqlite");
		expect(meta.readOnly).toBe(false);
		expect(meta.metaSource).toBe("schema");
		const password = meta.tables.users?.columns.find(
			(c) => c.tsName === "password",
		);
		expect(password?.hidden).toBe(true);
		expect(meta.tables.users?.uniqueKeys.length).toBeGreaterThan(0);
		expect(meta.tables.users?.relations.map((r) => r.name)).toContain(
			"posts",
		);
		expect(meta.tables.posts?.relations.map((r) => r.name)).toContain(
			"author",
		);
		expect("url" in meta).toBe(false);
	});

	it("flags junction tables and exposes m2m aliases", () => {
		const meta = toStudioMeta(manifest, { metaSource: "schema" });
		expect(meta.tables.posts_tags?.junction).toBe(true);
		expect(meta.tables.users?.junction).toBe(false);
		const tags = meta.tables.posts?.relations.find(
			(r) => r.name === "tags",
		);
		expect(tags?.m2m).toBe(true);
		expect(tags?.targetAccessor).toBe("tags");
	});

	it("marks tables without unique keys as browse/create only", () => {
		const copy = structuredClone(manifest);
		const users = copy.tables.users;
		if (!users) throw new Error("missing users table");
		users.primaryKey = [];
		for (const col of users.columns) {
			col.primary = false;
			col.unique = false;
		}
		users.indexes = users.indexes.filter((idx) => !idx.unique);
		const meta = toStudioMeta(copy, { metaSource: "schema" });
		expect(meta.tables.users?.mutable).toBe(false);
	});
});

describe("studio rows CRUD", () => {
	it("creates, lists (with hidden columns), updates and deletes", async () => {
		const created = await api(
			"/api/tables/users/rows",
			post({
				data: {
					email: "a@b.c",
					name: "alice",
					password: "s3cret",
					age: 30,
				},
			}),
		);
		expect(created.status).toBe(201);
		const row = (created.body as { row: Record<string, unknown> }).row;
		expect(row.email).toBe("a@b.c");

		const listed = await api("/api/tables/users/rows?take=50");
		expect(listed.status).toBe(200);
		const rows = (
			listed.body as { rows: Record<string, unknown>[]; total: number }
		).rows;
		expect(rows.length).toBe(1);
		expect(rows[0]?.password).toBe("s3cret");
		expect((listed.body as { total: number }).total).toBe(1);

		const updated = await api(
			"/api/tables/users/rows",
			patch({ where: { id: row.id }, data: { age: 31 } }),
		);
		expect(updated.status).toBe(200);
		expect((updated.body as { row: Record<string, unknown> }).row.age).toBe(
			31,
		);

		const deleted = await api(
			"/api/tables/users/rows",
			del({ where: { id: row.id } }),
		);
		expect(deleted.status).toBe(200);

		const after = await api("/api/tables/users/rows?take=50");
		expect((after.body as { total: number }).total).toBe(0);
	});

	it("maps constraint violations to 400 with codes", async () => {
		await api(
			"/api/tables/users/rows",
			post({ data: { email: "dup@x.c" } }),
		);
		const second = await api(
			"/api/tables/users/rows",
			post({ data: { email: "dup@x.c" } }),
		);
		expect(second.status).toBe(400);
		expect((second.body as { error: { code: string } }).error.code).toBe(
			"unique_violation",
		);
	});
});

describe("studio relations", () => {
	it("filters by relation and drills into related rows", async () => {
		const user = (
			await api(
				"/api/tables/users/rows",
				post({ data: { email: "rel@x.c" } }),
			)
		).body as {
			row: Record<string, unknown>;
		};
		await api(
			"/api/tables/posts/rows",
			post({ data: { title: "hello", authorId: user.row.id } }),
		);
		const filtered = await api(
			`/api/tables/posts/rows?where=${encodeURIComponent(JSON.stringify({ author: { email: "rel@x.c" } }))}`,
		);
		expect(filtered.status).toBe(200);
		expect((filtered.body as { rows: unknown[] }).rows.length).toBe(1);
	});

	it("connects many-to-many relations with nested writes", async () => {
		const posts = (await api("/api/tables/posts/rows?take=10")).body as {
			rows: Record<string, unknown>[];
		};
		const target = posts.rows[0];
		const tag = (
			await api(
				"/api/tables/tags/rows",
				post({ data: { slug: "typescript" } }),
			)
		).body as { row: Record<string, unknown> };
		const connected = await api(
			"/api/tables/posts/rows",
			patch({
				where: { id: target?.id },
				data: { tags: { connect: { id: tag.row.id } } },
			}),
		);
		expect(connected.status).toBe(200);
		const withTags = await api(
			`/api/tables/posts/rows?where=${encodeURIComponent(JSON.stringify({ id: target?.id }))}&with=${encodeURIComponent(JSON.stringify({ tags: true }))}`,
		);
		const rows = (withTags.body as { rows: Record<string, unknown>[] })
			.rows;
		expect((rows[0]?.tags as unknown[]).length).toBe(1);
	});
});

describe("studio sql and query playground", () => {
	it("executes parameterized sql", async () => {
		const { status, body } = await api(
			"/api/sql",
			post({ text: "select 1 + 1 as two", params: [] }),
		);
		expect(status).toBe(200);
		expect((body as { rows: Record<string, unknown>[] }).rows[0]?.two).toBe(
			2,
		);
	});

	it("round-trips playground findMany and count", async () => {
		const found = await api(
			"/api/query",
			post({ accessor: "users", method: "findMany", args: { take: 10 } }),
		);
		expect(found.status).toBe(200);
		expect(Array.isArray((found.body as { rows: unknown[] }).rows)).toBe(
			true,
		);
		const counted = await api(
			"/api/query",
			post({ accessor: "users", method: "count", args: {} }),
		);
		expect(counted.status).toBe(200);
		expect(typeof (counted.body as { result: unknown }).result).toBe(
			"number",
		);
	});
});

describe("studio read-only mode", () => {
	it("rejects row mutations and write sql", async () => {
		const write = await api(
			"/api/tables/users/rows",
			post({ data: { email: "nope@x.c" } }),
			readOnlyServer,
		);
		expect(write.status).toBe(403);
		const drop = await api(
			"/api/sql",
			post({ text: "delete from users", params: [] }),
			readOnlyServer,
		);
		expect(drop.status).toBe(403);
		const read = await api(
			"/api/sql",
			post({ text: "select 1 as one", params: [] }),
			readOnlyServer,
		);
		expect(read.status).toBe(200);
		const explain = await api(
			"/api/sql",
			post({ text: "select 1 as one", explain: true }),
			readOnlyServer,
		);
		expect(explain.status).toBe(200);
	});
});

describe("studio graph, migrate status, export", () => {
	it("serves nodes and edges including m2m", async () => {
		const { status, body } = await api("/api/graph");
		expect(status).toBe(200);
		const graph = body as ReturnType<typeof toStudioGraph>;
		expect(graph.nodes.map((n) => n.accessor)).toEqual(
			expect.arrayContaining(["users", "posts", "tags"]),
		);
		expect(graph.edges.length).toBeGreaterThan(0);
		expect(graph.edges.some((e) => e.m2m)).toBe(true);
	});

	it("reports migrate status without applying anything", async () => {
		const { status, body } = await api("/api/migrate/status");
		expect(status).toBe(200);
		const payload = body as {
			available: boolean;
			applied: unknown[];
			pending: unknown[];
			orphanApplied: unknown[];
		};
		expect(payload.available).toBe(true);
		expect(payload.applied).toEqual([]);
		expect(payload.pending).toEqual([]);
	});

	it("exports csv with a header row", async () => {
		const res = await fetch(
			`${server.url}/api/export?accessor=users&format=csv&take=10`,
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text.split("\n")[0]).toContain("email");
	});
});

describe("studio import and token", () => {
	it("imports json rows", async () => {
		const imported = await api(
			"/api/import",
			post({
				accessor: "users",
				rows: [{ email: "imp@x.c", name: "imported" }],
			}),
		);
		expect(imported.status).toBe(201);
		expect((imported.body as { count: number }).count).toBe(1);
	});

	it("rejects missing tokens and accepts a valid header", async () => {
		const denied = await api("/api/meta", undefined, tokenServer);
		expect(denied.status).toBe(401);
		const res = await fetch(`${tokenServer.url}/api/meta`, {
			headers: { "x-studio-token": "studio-secret" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { dialect: string };
		expect(body.dialect).toBe("sqlite");
	});

	it("accepts the token as a query parameter", async () => {
		const res = await fetch(
			`${tokenServer.url}/api/meta?token=studio-secret`,
		);
		expect(res.status).toBe(200);
	});
});

describe("studio codec and csv", () => {
	it("encodes bigint rows so JSON never throws", () => {
		const encoded = encodeStudioRow({
			id: 10n,
			when: new Date("2026-01-01T00:00:00.000Z"),
		});
		expect(() => JSON.stringify(encoded)).not.toThrow();
		const revived = decodeStudioValue(
			JSON.parse(JSON.stringify(encoded)) as unknown,
		);
		expect(revived).toEqual({
			id: 10n,
			when: new Date("2026-01-01T00:00:00.000Z"),
		});
	});

	it("coerces data payloads per column kind", () => {
		const table = manifest.tables.users;
		if (!table) throw new Error("missing users table");
		const decoded = decodeStudioData(table, { age: "42", name: "x" });
		expect(decoded.age).toBe("42");
	});

	it("round-trips csv", () => {
		const { headers, rows } = parseCsv(
			'email,name\n"a@b.c","Al, the great"\n',
		);
		expect(headers).toEqual(["email", "name"]);
		expect(rows).toEqual([{ email: "a@b.c", name: "Al, the great" }]);
		expect(toCsv(headers, rows)).toContain('"Al, the great"');
	});
});
