import type { ManifestTable } from "../dialect/types.js";
import { schemaError } from "../runtime/error-builders.js";

/**
 * Insert an introspected table into the accessor-keyed map, failing fast when
 * two distinct SQL table names derive the same accessor (e.g. `my_table` and
 * `myTables` both pluralize+camelize to `myTables`). Without this the second
 * table silently replaces the first, dropping an entity from the manifest.
 */
export function setIntrospectedTable(
	tables: Record<string, ManifestTable>,
	table: ManifestTable,
): void {
	const existing = tables[table.accessor];
	if (existing && existing.sqlName !== table.sqlName) {
		throw schemaError(
			"duplicate_table_accessor",
			`Tables "${existing.sqlName}" and "${table.sqlName}" both map to accessor "${table.accessor}"`,
			{
				tableAccessor: table.accessor,
				tableSqlName: table.sqlName,
			},
			[
				"Table accessors are derived by pluralizing and camelCasing the SQL table name, so names like my_table and myTables collide",
				"Rename one of the tables so their derived accessors differ",
			],
		);
	}
	tables[table.accessor] = table;
}
