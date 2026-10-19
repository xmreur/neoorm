export type SplitStatementsOptions = {
	/**
	 * Treat `\` as an escape character inside quoted strings and quoted
	 * identifiers (MySQL/MariaDB string syntax). Off by default: SQLite and
	 * PostgreSQL treat a backslash as a literal character in strings.
	 */
	backslashEscapes?: boolean;
};

/**
 * Split a SQL script into individual statements on `;` boundaries, honoring
 * quoted strings, quoted identifiers (backticks/double quotes), and
 * line/block comments — so `;` inside any of them never splits.
 */
export function splitStatements(
	sql: string,
	options?: SplitStatementsOptions,
): string[] {
	const backslash = options?.backslashEscapes === true;
	const statements: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const next = sql[i + 1];

		if (inLineComment) {
			current += ch;
			if (ch === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			current += ch;
			if (ch === "*" && next === "/") {
				current += next;
				i++;
				inBlockComment = false;
			}
			continue;
		}
		if (inSingle) {
			current += ch;
			if (backslash && ch === "\\") {
				if (next !== undefined) {
					current += next;
					i++;
				}
				continue;
			}
			if (ch === "'") {
				if (next === "'") {
					current += next;
					i++;
				} else {
					inSingle = false;
				}
			}
			continue;
		}
		if (inDouble) {
			current += ch;
			if (backslash && ch === "\\") {
				if (next !== undefined) {
					current += next;
					i++;
				}
				continue;
			}
			if (ch === '"') {
				if (next === '"') {
					current += next;
					i++;
				} else {
					inDouble = false;
				}
			}
			continue;
		}
		if (inBacktick) {
			current += ch;
			if (backslash && ch === "\\") {
				if (next !== undefined) {
					current += next;
					i++;
				}
				continue;
			}
			if (ch === "`") {
				if (next === "`") {
					current += next;
					i++;
				} else {
					inBacktick = false;
				}
			}
			continue;
		}
		if (ch === "-" && next === "-") {
			inLineComment = true;
			current += ch;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			current += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			current += ch;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			current += ch;
			continue;
		}
		if (ch === "`") {
			inBacktick = true;
			current += ch;
			continue;
		}
		if (ch === ";") {
			if (current.trim().length > 0) {
				statements.push(current.trim());
			}
			current = "";
			continue;
		}
		current += ch;
	}

	if (current.trim().length > 0) {
		statements.push(current.trim());
	}

	return statements.length > 0 ? statements : [sql];
}
