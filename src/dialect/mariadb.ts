import { createMysqlFamilyDialect } from "./mysql-family.js";
import type { Manifest, ManifestColumn } from "./types.js";

export const mariadbDialect = createMysqlFamilyDialect({
	name: "mariadb",
	unsupportedLabel: "MariaDB",
	citextCollation: "utf8mb4_uca1400_ai_ci",
	dropCheckKind: "constraint",
	upsertConflictSql: (_conflictCols, setClauses) =>
		`ON DUPLICATE KEY UPDATE ${setClauses}`,
	excludedRef: (quotedCol) => `VALUES(${quotedCol})`,
	search: (col, i) => `${col} REGEXP $${i}`,
	regex: (col, i, insensitive) =>
		insensitive
			? `${col} REGEXP CONCAT('(?i)', $${i})`
			: `${col} REGEXP $${i}`,
});

export function mariadbColumnType(
	col: ManifestColumn,
	manifest?: Manifest,
): string {
	return mariadbDialect.columnType(col, manifest);
}
