import type { Manifest, ManifestTable } from "../dialect/types.js";
import {
	NeoOrmDriverError,
	NeoOrmSchemaError,
	type SchemaErrorContext,
} from "./errors.js";

export type MigrateContext = {
	schema?: string;
	manifest?: Manifest;
	schemaPath?: string;
};

export function resolveMigrateContext(
	schemaOrContext?: string | MigrateContext,
): MigrateContext {
	if (typeof schemaOrContext === "string") {
		return { schema: schemaOrContext };
	}
	return schemaOrContext ?? {};
}

export function extractTableSqlName(statement: string): string | undefined {
	const match = statement.match(
		/^\s*(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|'([^']+)'|([a-zA-Z_][\w$]*))/i,
	);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function findTableBySqlName(
	manifest: Manifest,
	sqlName: string,
): ManifestTable | undefined {
	return Object.values(manifest.tables).find(
		(table) => table.sqlName === sqlName,
	);
}

function resolveManyToManyHint(
	manifest: Manifest,
	tableAccessor: string,
): string | undefined {
	const link = manifest.manyToMany.find(
		(m) => m.throughAccessor === tableAccessor,
	);
	if (link) {
		return `auto junction for ${link.leftAccessor} ↔ ${link.rightAccessor}`;
	}
	if (tableAccessor.startsWith("_")) {
		return "auto junction table";
	}
	return undefined;
}

function driverDetail(err: unknown): string {
	if (err instanceof NeoOrmDriverError) {
		const cause = err.cause;
		if (cause instanceof Error) {
			return cause.message;
		}
		return String(cause);
	}
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

export function enrichMigrationError(
	err: unknown,
	options: {
		schemaPath?: string;
		manifest?: Manifest;
		migrationName?: string;
		sqlPath?: string;
		statement?: string;
	},
): NeoOrmSchemaError {
	if (err instanceof NeoOrmSchemaError) {
		return err;
	}

	const statement =
		options.statement ??
		(err instanceof NeoOrmDriverError ? err.statement : undefined);

	let tableAccessor: string | undefined;
	let tableSqlName: string | undefined;
	let manyToManyHint: string | undefined;

	if (statement && options.manifest) {
		tableSqlName = extractTableSqlName(statement);
		if (tableSqlName) {
			const table = findTableBySqlName(options.manifest, tableSqlName);
			if (table) {
				tableAccessor = table.accessor;
				manyToManyHint = resolveManyToManyHint(
					options.manifest,
					table.accessor,
				);
			}
		}
	}

	const context: SchemaErrorContext = {
		...(options.schemaPath ? { schemaPath: options.schemaPath } : {}),
		...(tableAccessor ? { tableAccessor } : {}),
		...(tableSqlName ? { tableSqlName } : {}),
		...(manyToManyHint ? { manyToManyHint } : {}),
		...(options.migrationName ? { migrationName: options.migrationName } : {}),
		...(options.sqlPath ? { sqlPath: options.sqlPath } : {}),
		...(statement ? { statement } : {}),
		detail: driverDetail(err),
	};

	return new NeoOrmSchemaError(context, err);
}

export function schemaCompileError(
	schemaPath: string,
	detail: string,
	cause?: unknown,
): NeoOrmSchemaError {
	return new NeoOrmSchemaError({ schemaPath, detail }, cause);
}
