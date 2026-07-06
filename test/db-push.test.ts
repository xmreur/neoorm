import { defineSchema, id, table, text } from "neoorm/schema";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffManifest } from "../src/codegen/diff-manifest.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { introspectToManifest } from "../src/introspect/to-manifest.js";
import { dbPush } from "../src/migrate/runner.js";
import { manifestTable, manifestTableFromRecord } from "./helpers/manifest.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("db push integration", () => {
	let pool: Pool;

	beforeAll(() => {
		pool = new Pool({ connectionString: databaseUrl });
	});

	afterAll(async () => {
		await pool.query('DROP TABLE IF EXISTS "push_test_users"');
		await pool.end();
	});

	it("pushes schema to empty database and applies alters on second push", async () => {
		const schemaV1 = defineSchema({
			pushTestUsers: table("push_test_users", {
				id: id.primary(),
				name: text().notNull(),
			}),
		});

		const manifestV1 = schemaToManifest(schemaV1);
		await pool.query('DROP TABLE IF EXISTS "push_test_users"');

		const first = await dbPush(pool, manifestV1);
		expect(first.appliedStatements).toBeGreaterThan(0);

		const schemaV2 = defineSchema({
			pushTestUsers: table("push_test_users", {
				id: id.primary(),
				name: text().notNull(),
				nickname: text(),
			}),
		});
		const manifestV2 = schemaToManifest(schemaV2);

		const live = await introspectToManifest(pool);
		const diff = diffManifest(live, manifestV2);
		expect(diff.sql.some((s) => s.includes('ADD COLUMN "nickname"'))).toBe(
			true,
		);

		const second = await dbPush(pool, manifestV2);
		expect(second.appliedStatements).toBeGreaterThan(0);

		const liveAfter = await introspectToManifest(pool);
		const users = manifestTableFromRecord(liveAfter.tables, "pushTestUsers");
		expect(users.columns.some((c) => c.sqlName === "nickname")).toBe(true);
	});
});
