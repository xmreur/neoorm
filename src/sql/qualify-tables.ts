import {
	scanBacktickQuoted,
	scanDollarQuoted,
	scanDoubleQuoted,
	scanSingleQuoted,
} from "./template.js";

/** Keywords that can follow a table reference (not implicit aliases). */
const FOLLOWING_KEYWORDS = new Set([
	"ALL",
	"AND",
	"AS",
	"ASC",
	"BETWEEN",
	"CASE",
	"CROSS",
	"DELETE",
	"DESC",
	"DISTINCT",
	"ELSE",
	"END",
	"EXCEPT",
	"EXISTS",
	"FALSE",
	"FETCH",
	"FOR",
	"FROM",
	"FULL",
	"GROUP",
	"HAVING",
	"ILIKE",
	"IN",
	"INNER",
	"INSERT",
	"INTERSECT",
	"INTO",
	"IS",
	"JOIN",
	"LATERAL",
	"LEFT",
	"LIKE",
	"LIMIT",
	"NATURAL",
	"NOT",
	"NULL",
	"NULLS",
	"OFFSET",
	"ON",
	"ONLY",
	"OR",
	"ORDER",
	"OUTER",
	"RETURNING",
	"RIGHT",
	"SELECT",
	"SET",
	"SIMILAR",
	"TABLE",
	"THEN",
	"TRUE",
	"UNION",
	"UPDATE",
	"USING",
	"VALUES",
	"WHEN",
	"WHERE",
	"WINDOW",
	"WITH",
]);

export type QualifyTableIdentifiersOptions = {
	/** Unquoted SQL table names from the manifest. */
	tableNames: ReadonlySet<string>;
	/** Return a schema-qualified identifier for a table sqlName. */
	qualify: (sqlName: string) => string;
};

function precedingWord(sql: string, identStart: number): string {
	let i = identStart - 1;
	while (i >= 0 && /\s/.test(sql[i] ?? "")) i--;
	const end = i + 1;
	while (i >= 0 && /[A-Za-z_]/.test(sql[i] ?? "")) i--;
	return sql.slice(i + 1, end);
}

function isDotQualified(sql: string, identStart: number): boolean {
	let i = identStart - 1;
	while (i >= 0 && /\s/.test(sql[i] ?? "")) i--;
	return sql[i] === ".";
}

function readUnquotedIdent(
	sql: string,
	start: number,
): { ident: string; end: number } | undefined {
	const ch = sql[start];
	if (!ch || !/[A-Za-z_]/.test(ch)) return undefined;
	let j = start + 1;
	while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j] ?? "")) j++;
	return { ident: sql.slice(start, j), end: j };
}

function decodeDoubleQuoted(
	sql: string,
	start: number,
): {
	name: string;
	end: number;
} {
	const end = scanDoubleQuoted(sql, start);
	const raw = sql.slice(start + 1, end - 1);
	return { name: raw.replace(/""/g, '"'), end };
}

function matchingTable(
	ident: string,
	quoted: boolean,
	tableNames: ReadonlySet<string>,
): string | undefined {
	if (quoted) {
		return tableNames.has(ident) ? ident : undefined;
	}
	if (tableNames.has(ident)) return ident;
	const folded = ident.toLowerCase();
	if (folded !== ident && tableNames.has(folded)) return folded;
	return undefined;
}

function scanLineComment(sql: string, start: number): number {
	const newline = sql.indexOf("\n", start);
	return newline === -1 ? sql.length : newline + 1;
}

function scanBlockComment(sql: string, start: number): number {
	const end = sql.indexOf("*/", start + 2);
	return end === -1 ? sql.length : end + 2;
}

/**
 * Schema-qualify unqualified table identifiers in raw SQL.
 *
 * Skips string literals, quoted non-tables, comments, dollar-quotes, identifiers
 * after `AS`, and the optional alias immediately after a table reference.
 * Already-qualified `schema.table` refs are left unchanged.
 */
export function qualifyTableIdentifiers(
	sql: string,
	options: QualifyTableIdentifiersOptions,
): string {
	const { tableNames, qualify } = options;
	if (tableNames.size === 0) return sql;

	let result = "";
	let i = 0;
	let expectAlias = false;

	const copySpan = (end: number) => {
		result += sql.slice(i, end);
		i = end;
	};

	const handleIdent = (
		ident: string,
		quoted: boolean,
		raw: string,
		end: number,
	) => {
		if (precedingWord(sql, i).toUpperCase() === "AS") {
			expectAlias = false;
			result += raw;
			i = end;
			return;
		}

		const keyword = !quoted && FOLLOWING_KEYWORDS.has(ident.toUpperCase());
		if (expectAlias && !keyword) {
			expectAlias = false;
			result += raw;
			i = end;
			return;
		}
		if (keyword) {
			expectAlias = false;
		}

		if (isDotQualified(sql, i)) {
			const table = matchingTable(ident, quoted, tableNames);
			if (table) expectAlias = true;
			result += raw;
			i = end;
			return;
		}

		const table = matchingTable(ident, quoted, tableNames);
		if (table) {
			result += qualify(table);
			expectAlias = true;
			i = end;
			return;
		}

		result += raw;
		i = end;
	};

	while (i < sql.length) {
		const ch = sql[i];
		const next = sql[i + 1];

		if (ch === "-" && next === "-") {
			copySpan(scanLineComment(sql, i));
			continue;
		}
		if (ch === "/" && next === "*") {
			copySpan(scanBlockComment(sql, i));
			continue;
		}
		if (ch === "'") {
			copySpan(scanSingleQuoted(sql, i));
			continue;
		}
		if (ch === "`") {
			copySpan(scanBacktickQuoted(sql, i));
			continue;
		}
		if (ch === "$") {
			const dollarEnd = scanDollarQuoted(sql, i);
			if (dollarEnd !== -1) {
				copySpan(dollarEnd);
				continue;
			}
		}
		if (ch === '"') {
			const { name, end } = decodeDoubleQuoted(sql, i);
			handleIdent(name, true, sql.slice(i, end), end);
			continue;
		}

		const unquoted = readUnquotedIdent(sql, i);
		if (unquoted) {
			handleIdent(
				unquoted.ident,
				false,
				sql.slice(i, unquoted.end),
				unquoted.end,
			);
			continue;
		}

		result += ch;
		i++;
	}

	return result;
}
