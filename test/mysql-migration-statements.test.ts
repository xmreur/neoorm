import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import {
	applyMigration,
	ensureMigrationsTable,
	hashMigrationSql,
	revertMigration,
} from "../src/migrate/runner.js";
import type { DatabaseClient, DriverResult } from "../src/runtime/driver.js";
import { splitStatements } from "../src/sql/split-statements.js";

function recordingClient(
	probeRow?: Record<string, unknown>,
	ledger: Record<string, unknown>[] = [],
): {
	client: DatabaseClient;
	queries: string[];
} {
	const queries: string[] = [];
	const client: DatabaseClient = {
		query: async <T = Record<string, unknown>>(text: string) => {
			queries.push(text);
			if (probeRow && /information_schema\.COLUMNS/i.test(text)) {
				return { rows: [probeRow], rowCount: 1 } as DriverResult<T>;
			}
			if (text.includes("down_checksum") && /^\s*SELECT/i.test(text)) {
				return {
					rows: ledger,
					rowCount: ledger.length,
				} as DriverResult<T>;
			}
			return { rows: [], rowCount: 0 } as DriverResult<T>;
		},
		transaction: async (fn) => fn(client),
		close: async () => {},
	};
	return { client, queries };
}

const MULTI_STATEMENT = [
	"CREATE TABLE `ta` (id INT PRIMARY KEY);",
	"",
	"CREATE TABLE `tb` (id INT PRIMARY KEY, note VARCHAR(50) DEFAULT 'a;b');",
].join("\n");

describe("splitStatements", () => {
	it("splits on statement-terminating semicolons", () => {
		expect(splitStatements("SELECT 1;\n\nSELECT 2")).toEqual([
			"SELECT 1",
			"SELECT 2",
		]);
	});

	it("keeps semicolons inside strings, backticks, and comments", () => {
		expect(
			splitStatements(
				"CREATE TABLE `we;ird` (note VARCHAR(10) DEFAULT 'a;b');\n\n-- trailing; comment\nCREATE INDEX `ix` ON `we;ird` (`note`);",
			),
		).toEqual([
			"CREATE TABLE `we;ird` (note VARCHAR(10) DEFAULT 'a;b')",
			"-- trailing; comment\nCREATE INDEX `ix` ON `we;ird` (`note`)",
		]);
		expect(splitStatements("SELECT 'it''s; fine' /* ; */")).toEqual([
			"SELECT 'it''s; fine' /* ; */",
		]);
	});

	it("does not treat backslashes as escapes by default", () => {
		expect(splitStatements("INSERT INTO t VALUES ('a\\'; b')")).toEqual([
			"INSERT INTO t VALUES ('a\\'",
			"b')",
		]);
	});

	it("treats backslashes as escapes when backslashEscapes is set", () => {
		expect(
			splitStatements("INSERT INTO t VALUES ('a\\'; b');\n\nSELECT 2", {
				backslashEscapes: true,
			}),
		).toEqual(["INSERT INTO t VALUES ('a\\'; b')", "SELECT 2"]);
	});

	it("returns the original input when there is nothing to split", () => {
		expect(splitStatements("-- only a comment")).toEqual([
			"-- only a comment",
		]);
	});
});

describe("mysql/mariadb migration file handling", () => {
	const tmpDirs: string[] = [];

	afterEach(async () => {
		while (tmpDirs.length > 0) {
			const dir = tmpDirs.pop();
			if (dir) {
				await rm(dir, { recursive: true, force: true });
			}
		}
	});

	async function writeMigrationFile(
		prefix: string,
		fileName: string,
		content: string,
	): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), prefix));
		tmpDirs.push(root);
		const migrationsDir = join(root, "migrations");
		await mkdir(join(migrationsDir, "20200101_init"), {
			recursive: true,
		});
		await writeFile(
			join(migrationsDir, "20200101_init", fileName),
			content,
			"utf-8",
		);
		return migrationsDir;
	}

	for (const dialect of [mysqlDialect, mariadbDialect]) {
		it(`probes the ledger checksum column without the reserved \`exists\` alias on ${dialect.name}`, async () => {
			const { client, queries } = recordingClient({ checksum_count: 1 });

			await ensureMigrationsTable(client, dialect);

			const probe = queries.find((sql) =>
				/information_schema\.COLUMNS/i.test(sql),
			);
			expect(probe).toBeDefined();
			// `exists` is reserved on MySQL/MariaDB — an unquoted alias is a
			// ER 1064 syntax error.
			expect(probe).not.toMatch(/AS\s+exists\b/i);
			expect(probe).toContain("AS checksum_count");
			// checksum column reported present → no ALTER
			expect(queries.some((sql) => /ADD COLUMN checksum/.test(sql))).toBe(
				false,
			);
		});

		it(`applies a multi-statement migration file statement by statement on ${dialect.name}`, async () => {
			const migrationsDir = await writeMigrationFile(
				"neoorm-mysql-split-",
				"migration.sql",
				MULTI_STATEMENT,
			);

			const { client, queries } = recordingClient();
			await applyMigration(
				client,
				dialect,
				migrationsDir,
				"20200101_init",
			);

			expect(queries).toHaveLength(3);
			expect(queries[0]).toBe("CREATE TABLE `ta` (id INT PRIMARY KEY)");
			expect(queries[1]).toBe(
				"CREATE TABLE `tb` (id INT PRIMARY KEY, note VARCHAR(50) DEFAULT 'a;b')",
			);
			expect(queries[2]).toContain("INSERT INTO");
		});

		it(`reverts a multi-statement down.sql statement by statement on ${dialect.name}`, async () => {
			const downSql = "DROP TABLE `tb`;\n\nDROP TABLE `ta`;";
			const migrationsDir = await writeMigrationFile(
				"neoorm-mysql-down-",
				"down.sql",
				downSql,
			);

			const { client, queries } = recordingClient(undefined, [
				{
					name: "20200101_init",
					checksum: "unused",
					down_checksum: hashMigrationSql(downSql),
					applied_at: "2020-01-01T00:00:00.000Z",
				},
			]);
			await revertMigration(
				client,
				dialect,
				migrationsDir,
				"20200101_init",
			);

			expect(
				queries.filter(
					(sql) =>
						sql.startsWith("DROP TABLE") ||
						sql.includes("DELETE FROM"),
				),
			).toEqual([
				"DROP TABLE `tb`",
				"DROP TABLE `ta`",
				expect.stringContaining("DELETE FROM"),
			]);
		});
	}

	it("keeps postgres sending the whole file in a single query", async () => {
		const migrationsDir = await writeMigrationFile(
			"neoorm-pg-split-",
			"migration.sql",
			MULTI_STATEMENT,
		);

		const { client, queries } = recordingClient();
		await applyMigration(
			client,
			postgresDialect,
			migrationsDir,
			"20200101_init",
		);

		// the whole file goes over the wire as one query (pg supports
		// multi-statement payloads) — exactly as before this change
		expect(queries).toContain(MULTI_STATEMENT);
		expect(
			queries.filter((sql) => sql.includes("CREATE TABLE `ta`")),
		).toEqual([MULTI_STATEMENT]);
		expect(queries.at(-1)).toContain("INSERT INTO");
	});
});
