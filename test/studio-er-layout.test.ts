import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { dbPush } from "../src/migrate/runner.js";
import { sqliteClient } from "../src/runtime/driver.js";
import { defineSchema, fk, serial, table, text } from "../src/schema/index.js";
import {
	loadSharedErLayout,
	parseSharedErLayout,
	saveSharedErLayout,
} from "../src/studio/er-layout.js";
import { type StudioServer, startStudioServer } from "../src/studio/server.js";

describe("shared ER layout validation", () => {
	it("accepts positions, junctions flag and viewport", () => {
		const layout = parseSharedErLayout({
			positions: { users: { x: 10, y: 20 }, posts: { x: 1, y: 2 } },
			showJunctions: true,
			viewport: { x: 5, y: 6, zoom: 1.2 },
		});
		expect(layout.positions.users).toEqual({ x: 10, y: 20 });
		expect(layout.showJunctions).toBe(true);
		expect(layout.viewport).toEqual({ x: 5, y: 6, zoom: 1.2 });
	});

	it("drops invalid entries and clamps ranges", () => {
		const layout = parseSharedErLayout({
			positions: {
				ok: { x: 0, y: 0 },
				bad: { x: Number.NaN, y: 1 },
				far: { x: 9999999, y: -9999999 },
			},
			viewport: { x: 0, y: 0, zoom: 99 },
		});
		expect(layout.positions.ok).toEqual({ x: 0, y: 0 });
		expect(layout.positions.bad).toBeUndefined();
		expect(layout.positions.far).toEqual({ x: 100000, y: -100000 });
		expect(layout.viewport?.zoom).toBe(4);
	});

	it("rejects non-objects and missing positions", () => {
		expect(() => parseSharedErLayout(null)).toThrow();
		expect(() => parseSharedErLayout({})).toThrow();
	});

	it("round-trips through disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "er-layout-"));
		const path = join(dir, "neoorm.er-layout.json");
		expect(await loadSharedErLayout(path)).toBeNull();
		const layout = parseSharedErLayout({
			positions: { users: { x: 1, y: 2 } },
			showJunctions: false,
		});
		await saveSharedErLayout(path, layout);
		const loaded = await loadSharedErLayout(path);
		expect(loaded?.positions.users).toEqual({ x: 1, y: 2 });
	});
});

describe("studio ER layout API", () => {
	const schema = defineSchema({
		users: table({
			id: serial().primary(),
			email: text().notNull().unique(),
		}),
		posts: table({
			id: serial().primary(),
			authorId: fk("users.id").as("author").inverse("posts").notNull(),
		}),
	});
	const manifest = schemaToManifest(schema, [], {
		provider: "sqlite",
		url: "sqlite://er-layout-test",
	});
	const dir = mkdtempSync(join(tmpdir(), "er-layout-api-"));
	const layoutPath = join(dir, "neoorm.er-layout.json");
	let rawDb: DatabaseSync;
	let server: StudioServer;
	let readOnlyServer: StudioServer;
	let plainServer: StudioServer;

	beforeAll(async () => {
		rawDb = new DatabaseSync(":memory:");
		await dbPush(sqliteClient(rawDb), sqliteDialect, manifest);
		server = await startStudioServer({
			port: 0,
			manifest,
			sqliteDb: rawDb,
			provider: "sqlite",
			version: "test",
			erLayoutPath: layoutPath,
		});
		readOnlyServer = await startStudioServer({
			port: 0,
			manifest,
			sqliteDb: rawDb,
			provider: "sqlite",
			version: "test",
			readOnly: true,
			erLayoutPath: join(dir, "readonly-layout.json"),
		});
		plainServer = await startStudioServer({
			port: 0,
			manifest,
			sqliteDb: rawDb,
			provider: "sqlite",
			version: "test",
		});
	});

	afterAll(async () => {
		await server.close();
		await readOnlyServer.close();
		await plainServer.close();
		rawDb.close();
	});

	it("returns empty then saves and loads a shared layout", async () => {
		const empty = (await fetch(`${server.url}/api/graph/layout`).then((r) =>
			r.json(),
		)) as { available: boolean };
		expect(empty.available).toBe(false);

		const put = await fetch(`${server.url}/api/graph/layout`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				positions: { users: { x: 11, y: 22 } },
				showJunctions: true,
				viewport: { x: 1, y: 2, zoom: 1 },
			}),
		});
		expect(put.status).toBe(200);

		const loaded = (await fetch(`${server.url}/api/graph/layout`).then(
			(r) => r.json(),
		)) as {
			available: boolean;
			layout: {
				positions: Record<string, { x: number; y: number }>;
				showJunctions: boolean;
			};
		};
		expect(loaded.available).toBe(true);
		expect(loaded.layout.positions.users).toEqual({ x: 11, y: 22 });
		expect(loaded.layout.showJunctions).toBe(true);
	});

	it("rejects invalid payloads and read-only writes", async () => {
		const bad = await fetch(`${server.url}/api/graph/layout`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ positions: null }),
		});
		expect(bad.status).toBe(400);

		const ro = await fetch(`${readOnlyServer.url}/api/graph/layout`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ positions: {} }),
		});
		expect(ro.status).toBe(403);
	});

	it("404s when shared layout is not enabled", async () => {
		const res = await fetch(`${plainServer.url}/api/graph/layout`);
		expect(res.status).toBe(404);
	});
});
