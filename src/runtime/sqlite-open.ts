import { createRequire } from "node:module";
import type { SqliteDatabaseLike } from "./driver.js";
import { schemaError } from "./error-builders.js";
import { SchemaErrorCode } from "./error-codes.js";

const require = createRequire(import.meta.url);

const POSTGRES_URL = /^(postgres(ql)?:)/i;

function usableSqlitePath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	if (POSTGRES_URL.test(path)) return undefined;
	return path;
}

/** File path or `:memory:` for SQLite. Ignores PostgreSQL `DATABASE_URL` values. */
export function resolveSqliteDatabasePath(
	databasePath: string | undefined,
	manifestUrl: string | undefined,
): string {
	return (
		usableSqlitePath(databasePath) ??
		usableSqlitePath(process.env["DATABASE_URL"]) ??
		usableSqlitePath(manifestUrl) ??
		":memory:"
	);
}

export function openSqliteDatabase(databasePath: string): SqliteDatabaseLike {
	const bunRuntime =
		typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
	if (bunRuntime) {
		try {
			const { Database } = require("bun:sqlite") as {
				Database: new (path: string) => SqliteDatabaseLike;
			};
			return new Database(databasePath);
		} catch {
			// fall through to node:sqlite
		}
	}

	try {
		const { DatabaseSync } = require("node:sqlite") as {
			DatabaseSync: new (path: string) => SqliteDatabaseLike;
		};
		return new DatabaseSync(databasePath);
	} catch {
		throw schemaError(
			SchemaErrorCode.invalid_config,
			"No SQLite driver available. Provide a `db` instance, or run on Bun or Node.js 22.5+ so `databasePath` can be opened automatically.",
		);
	}
}
