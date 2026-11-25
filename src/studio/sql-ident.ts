/** Quote a SQL identifier for client-built statements. */
export function quoteSqlIdent(dialect: string, name: string): string {
	if (dialect === "mysql" || dialect === "mariadb") {
		return `\`${name.replaceAll("`", "``")}\``;
	}
	return `"${name.replaceAll('"', '""')}"`;
}

/** Table reference for client-built INSERT statements. */
export function qualifiedSqlTable(
	dialect: string,
	sqlName: string,
	schema?: string,
): string {
	const table = quoteSqlIdent(dialect, sqlName);
	if (dialect === "postgresql" && schema && schema !== "public") {
		return `${quoteSqlIdent(dialect, schema)}.${table}`;
	}
	return table;
}
