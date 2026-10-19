import { createRequire } from "node:module";
import type { SqliteDatabaseLike } from "./driver.js";
import { schemaError } from "./error-builders.js";
import { SchemaErrorCode } from "./error-codes.js";

const require = createRequire(import.meta.url);

// A `scheme://` prefix marks a connection URL. Only `file:`/`sqlite:` are
// valid SQLite URIs; every other scheme (postgres://, mysql://, mariadb://, …)
// is another engine's connection URL and must never become a literal file path.
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const SQLITE_URI_SCHEMES = new Set(["file", "sqlite"]);

function usableSqlitePath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const scheme = URL_SCHEME.exec(path)?.[1]?.toLowerCase();
	if (scheme !== undefined && !SQLITE_URI_SCHEMES.has(scheme)) {
		return undefined;
	}
	return path;
}

/** File path or `:memory:` for SQLite. Ignores PostgreSQL `DATABASE_URL` values. */
export function resolveSqliteDatabasePath(
	databasePath: string | undefined,
	manifestUrl: string | undefined,
): string {
	return (
		usableSqlitePath(databasePath) ??
		usableSqlitePath(process.env.DATABASE_URL) ??
		usableSqlitePath(manifestUrl) ??
		":memory:"
	);
}

export function openSqliteDatabase(databasePath: string): SqliteDatabaseLike {
	const bunRuntime =
		typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
	if (bunRuntime) {
		let Database: (new (path: string) => SqliteDatabaseLike) | undefined;
		try {
			Database = (
				require("bun:sqlite") as {
					Database: new (path: string) => SqliteDatabaseLike;
				}
			).Database;
		} catch {
			// bun:sqlite unavailable — fall through to node:sqlite
		}
		if (Database) {
			// Open outside the require try: a real open failure (bad path,
			// permissions, is-a-directory) must surface as itself, not be
			// conflated with a missing driver.
			return new Database(databasePath);
		}
	}

	let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
	try {
		DatabaseSync = (
			require("node:sqlite") as {
				DatabaseSync: new (path: string) => SqliteDatabaseLike;
			}
		).DatabaseSync;
	} catch {
		throw schemaError(
			SchemaErrorCode.invalid_config,
			"No SQLite driver available. Provide a `db` instance, or run on Bun or Node.js 22.5+ so `databasePath` can be opened automatically.",
		);
	}
	// Open outside the require try: a real open failure must surface as itself,
	// not be reported as "No SQLite driver available".
	return new DatabaseSync(databasePath);
}
