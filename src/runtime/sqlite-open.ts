import { createRequire } from "node:module";
import { SchemaErrorCode } from "./error-codes.js";
import { schemaError } from "./error-builders.js";
import type { SqliteDatabaseLike } from "./driver.js";

const require = createRequire(import.meta.url);

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