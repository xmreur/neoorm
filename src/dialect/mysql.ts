import {
	createMysqlFamilyDialect,
	quoteMysqlIdentifier,
} from "./mysql-family.js";
import type { Manifest, ManifestColumn } from "./types.js";

export { quoteMysqlIdentifier };

export const mysqlDialect = createMysqlFamilyDialect({
	name: "mysql",
	unsupportedLabel: "MySQL",
	citextCollation: "utf8mb4_0900_ai_ci",
	dropCheckKind: "check",
	upsertConflictSql: (_conflictCols, setClauses) =>
		`AS new ON DUPLICATE KEY UPDATE ${setClauses}`,
	excludedRef: (quotedCol) => `new.${quotedCol}`,
	search: (col) => `REGEXP_LIKE(${col}, ?)`,
	regex: (col, _i, insensitive) =>
		insensitive ? `REGEXP_LIKE(${col}, ?, 'i')` : `REGEXP_LIKE(${col}, ?)`,
});

export function mysqlColumnType(
	col: ManifestColumn,
	manifest?: Manifest,
): string {
	return mysqlDialect.columnType(col, manifest);
}
