import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	openSqliteDatabase,
	resolveSqliteDatabasePath,
} from "./sqlite-open.js";

const workDir = join(tmpdir(), "neoorm-sqlite-open-test");

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("openSqliteDatabase error reporting", () => {
	it("surfaces a real open failure instead of 'no driver available'", () => {
		// node:sqlite is present here (its require succeeds). Only the open
		// fails because the parent directory does not exist. That real error
		// must not be swallowed and re-reported as a missing driver.
		mkdirSync(workDir, { recursive: true });
		expect(() =>
			openSqliteDatabase(join(workDir, "no", "such", "dir", "db.sqlite")),
		).toThrowError(/unable to open database file/);
		expect(() =>
			openSqliteDatabase(join(workDir, "no", "such", "dir", "db.sqlite")),
		).not.toThrowError(/No SQLite driver available/);
	});

	it("surfaces a real open failure when the path is a directory", () => {
		mkdirSync(workDir, { recursive: true });
		expect(() => openSqliteDatabase(workDir)).toThrowError(
			/unable to open database file/,
		);
		expect(() => openSqliteDatabase(workDir)).not.toThrowError(
			/No SQLite driver available/,
		);
	});
});

describe("resolveSqliteDatabasePath URL handling", () => {
	const envSave = process.env.DATABASE_URL;
	afterEach(() => {
		delete process.env.DATABASE_URL;
		if (envSave !== undefined) process.env.DATABASE_URL = envSave;
	});

	it("ignores non-SQLite connection URLs (mysql, mariadb, …), like postgres", () => {
		delete process.env.DATABASE_URL;
		// These are other engines' connection URLs, never literal file paths.
		expect(resolveSqliteDatabasePath(undefined, "mysql://h/db")).toBe(
			":memory:",
		);
		expect(resolveSqliteDatabasePath(undefined, "mariadb://h/db")).toBe(
			":memory:",
		);
		expect(resolveSqliteDatabasePath(undefined, "postgres://h/db")).toBe(
			":memory:",
		);
		expect(resolveSqliteDatabasePath(undefined, "postgresql://h/db")).toBe(
			":memory:",
		);
		expect(resolveSqliteDatabasePath(undefined, "mongodb://h/db")).toBe(
			":memory:",
		);
	});

	it("passes SQLite file URIs and plain paths through unchanged", () => {
		delete process.env.DATABASE_URL;
		expect(resolveSqliteDatabasePath(undefined, "file:/tmp/x.db")).toBe(
			"file:/tmp/x.db",
		);
		expect(resolveSqliteDatabasePath(undefined, "file:///tmp/x.db")).toBe(
			"file:///tmp/x.db",
		);
		expect(resolveSqliteDatabasePath(undefined, "sqlite:/tmp/x.db")).toBe(
			"sqlite:/tmp/x.db",
		);
		expect(resolveSqliteDatabasePath(undefined, ":memory:")).toBe(
			":memory:",
		);
		expect(resolveSqliteDatabasePath("./rel.db", undefined)).toBe(
			"./rel.db",
		);
		// A Windows path has a drive letter but no `//`, so it is not a URL.
		expect(resolveSqliteDatabasePath(undefined, "C:\\data\\x.db")).toBe(
			"C:\\data\\x.db",
		);
	});

	it("falls through a bad explicit URL to the next usable source", () => {
		delete process.env.DATABASE_URL;
		// explicit databasePath is a mysql URL → not usable → manifest path wins
		expect(resolveSqliteDatabasePath("mysql://h/db", "/tmp/ok.db")).toBe(
			"/tmp/ok.db",
		);
	});

	it("prefers an explicit path and falls back to :memory:", () => {
		delete process.env.DATABASE_URL;
		expect(resolveSqliteDatabasePath("/abs/x.db", "mysql://h/db")).toBe(
			"/abs/x.db",
		);
		expect(resolveSqliteDatabasePath(undefined, undefined)).toBe(
			":memory:",
		);
	});

	it("ignores a non-SQLite DATABASE_URL and uses the manifest url", () => {
		process.env.DATABASE_URL = "postgres://env/db";
		expect(resolveSqliteDatabasePath(undefined, "/tmp/m.db")).toBe(
			"/tmp/m.db",
		);
	});
});
