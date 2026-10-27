import { mkdirSync, mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

	it("refuses a bulk delete or update with no where", async () => {
		const created = await api(
			"/api/tables/users/rows",
			post({ data: { email: "keep@x.c", name: "keep" } }),
		);
		const id = (created.body as { row: { id: number } }).row.id;

		const missing = await api("/api/tables/users/rows?many=true", del({}));
		expect(missing.status).toBe(400);
		expect((missing.body as { error: { code: string } }).error.code).toBe(
			"where_required",
		);

		const empty = await api(
			"/api/tables/users/rows",
			del({ many: true, where: {} }),
		);
		expect(empty.status).toBe(400);

		const unscopedUpdate = await api(
			"/api/tables/users/rows",
			patch({ many: true, data: { name: "wiped" } }),
		);
		expect(unscopedUpdate.status).toBe(400);

		const still = await api(
			`/api/tables/users/rows?where=${encodeURIComponent(JSON.stringify({ id }))}`,
		);
		const kept = (still.body as { rows: { name: string }[] }).rows[0];
		expect(kept?.name).toBe("keep");

		const scoped = await api(
			"/api/tables/users/rows",
			del({ many: true, where: { id } }),
		);
		expect(scoped.status).toBe(200);
		expect((scoped.body as { count: number }).count).toBe(1);
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

	it("caps playground take at 500", async () => {
		const rows = Array.from({ length: 501 }, (_, i) => ({
			email: `cap-${i}@x.c`,
		}));
		const created = await api("/api/tables/users/rows", post({ rows }));
		expect(created.status).toBe(201);

		const omitted = await api(
			"/api/query",
			post({ accessor: "users", method: "findMany", args: {} }),
		);
		expect(omitted.status).toBe(200);
		expect((omitted.body as { rows: unknown[] }).rows).toHaveLength(500);

		const huge = await api(
			"/api/query",
			post({
				accessor: "users",
				method: "findMany",
				args: { take: 100_000 },
			}),
		);
		expect((huge.body as { rows: unknown[] }).rows).toHaveLength(500);

		const small = await api(
			"/api/query",
			post({
				accessor: "users",
				method: "findMany",
				args: { take: 3 },
			}),
		);
		expect((small.body as { rows: unknown[] }).rows).toHaveLength(3);

		const page = await api(
			"/api/query",
			post({
				accessor: "users",
				method: "paginate",
				args: { orderBy: { id: "asc" }, take: 100_000 },
			}),
		);
		expect(page.status).toBe(200);
		expect((page.body as { items: unknown[] }).items).toHaveLength(500);

		const removed = await api(
			"/api/tables/users/rows",
			del({
				many: true,
				where: { email: { startsWith: "cap-" } },
			}),
		);
		expect(removed.status).toBe(200);
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
		const explainWrite = await api(
			"/api/sql",
			post({ text: "delete from users", explain: true }),
			readOnlyServer,
		);
		expect(explainWrite.status).toBe(403);
		const explainAnalyzeWrite = await api(
			"/api/sql",
			post({ text: "delete from users", explain: "analyze" }),
			readOnlyServer,
		);
		expect(explainAnalyzeWrite.status).toBe(403);
		const modifyingCte = await api(
			"/api/sql",
			post({
				text: "with d as (delete from users returning id) select * from d",
			}),
			readOnlyServer,
		);
		expect(modifyingCte.status).toBe(403);
		const quotedWrite = await api(
			"/api/sql",
			post({ text: "select 'delete from users' as note" }),
			readOnlyServer,
		);
		expect(quotedWrite.status).toBe(200);
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

	it("rejects a token in the query string and accepts a bearer token", async () => {
		const query = await fetch(
			`${tokenServer.url}/api/meta?token=studio-secret`,
		);
		expect(query.status).toBe(401);
		const bearer = await fetch(`${tokenServer.url}/api/meta`, {
			headers: { Authorization: "Bearer studio-secret" },
		});
		expect(bearer.status).toBe(200);
	});
});

function rawStudioRequest(
	base: StudioServer,
	path: string,
	options: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	} = {},
): Promise<{ status: number; body: string }> {
	const url = new URL(path, base.url);
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: url.hostname,
				port: url.port,
				path: `${url.pathname}${url.search}`,
				method: options.method ?? "GET",
				headers: options.headers,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => {
					chunks.push(
						typeof chunk === "string" ? Buffer.from(chunk) : chunk,
					);
				});
				res.on("end", () => {
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		req.on("error", reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

describe("studio CSRF and DNS rebinding guards", () => {
	it("rejects a website Origin on SQL so CSRF cannot run queries", async () => {
		const res = await fetch(`${server.url}/api/sql`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://evil.example",
			},
			body: JSON.stringify({ text: "SELECT 1" }),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("forbidden_origin");
	});

	it("rejects text/plain JSON bodies that skip CORS preflight", async () => {
		const res = await fetch(`${server.url}/api/sql`, {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: JSON.stringify({ text: "SELECT 1" }),
		});
		expect(res.status).toBe(415);
	});

	it("rejects a DNS-rebind Host on the SQL endpoint", async () => {
		const port = new URL(server.url).port;
		const res = await rawStudioRequest(server, "/api/sql", {
			method: "POST",
			headers: {
				Host: `evil.example:${port}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text: "SELECT 1" }),
		});
		expect(res.status).toBe(403);
		expect(res.body).toContain("forbidden_host");
	});

	it("accepts loopback Origin and application/json on SQL", async () => {
		const origin = new URL(server.url).origin;
		const res = await fetch(`${server.url}/api/sql`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: origin,
			},
			body: JSON.stringify({ text: "SELECT 1 AS ok" }),
		});
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

	it("prefixes spreadsheet formulas and keeps numeric text", () => {
		const csv = toCsv(
			["=name"],
			[
				{ "=name": "=1+1" },
				{ "=name": "+cmd" },
				{ "=name": "-2+3" },
				{ "=name": "@SUM(A1)" },
				{ "=name": "\t=1" },
				{ "=name": "=1,2" },
				{ "=name": "-12.50" },
				{ "=name": -12.5 },
				{ "=name": "ok" },
			],
		);
		const lines = csv.split("\n");
		expect(lines[0]).toBe("'=name");
		expect(lines[1]).toBe("'=1+1");
		expect(lines[2]).toBe("'+cmd");
		expect(lines[3]).toBe("'-2+3");
		expect(lines[4]).toBe("'@SUM(A1)");
		expect(lines[5]).toBe("'\t=1");
		expect(lines[6]).toBe(`"'=1,2"`);
		expect(lines[7]).toBe("-12.50");
		expect(lines[8]).toBe("-12.5");
		expect(lines[9]).toBe("ok");
		const cr = String.fromCharCode(13);
		expect(toCsv(["n"], [{ n: `${cr}=1` }])).toBe(`n\n"'${cr}=1"\n`);
	});
});

describe("studio error responses", () => {
	it("returns 400 for invalid take, skip, and JSON query params", async () => {
		const take = await api("/api/tables/users/rows?take=0");
		expect(take.status).toBe(400);
		expect((take.body as { error: { code: string } }).error.code).toBe(
			"invalid_args",
		);

		const skip = await api("/api/tables/users/rows?skip=-1");
		expect(skip.status).toBe(400);

		const where = await api("/api/tables/users/rows?where=not-json");
		expect(where.status).toBe(400);
		expect(
			(where.body as { error: { message: string } }).error.message,
		).toBe("`where` must be JSON");
	});

	it("returns 400 for invalid JSON bodies", async () => {
		const res = await fetch(`${server.url}/api/sql`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("invalid_json");
		expect(body.error.message).toBe("Invalid JSON");
	});

	it("returns 413 when the body exceeds the limit", async () => {
		const res = await fetch(`${server.url}/api/sql`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "x".repeat(10 * 1024 * 1024 + 1),
		});
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("payload_too_large");
	});

	it("does not echo filesystem paths when serving the UI fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "studio-ui-"));
		mkdirSync(join(dir, "index.html"));
		const ui = await startStudioServer({
			port: 0,
			manifest,
			sqliteDb: db,
			provider: "sqlite",
			version: "test",
			uiDir: dir,
		});
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await fetch(`${ui.url}/`);
			const text = await res.text();
			expect(res.status).toBe(500);
			expect(text).toBe("Internal server error");
			expect(text).not.toContain(dir);
		} finally {
			spy.mockRestore();
			await ui.close();
		}
	});
});
