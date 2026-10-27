import {
	scanBacktickQuoted,
	scanDollarQuoted,
	scanDoubleQuoted,
	scanSingleQuoted,
} from "../sql/template.js";

const READ_START = new Set([
	"SELECT",
	"WITH",
	"VALUES",
	"TABLE",
	"PRAGMA",
	"SHOW",
	"DESCRIBE",
	"DESC",
]);

const BACKTICK = "`";

/**
 * True when every statement is a read.
 * EXPLAIN of a write, and DML nested in WITH or SELECT, are rejected.
 * Strings, comments, and quoted identifiers are ignored. MySQL conditional
 * comments stay visible because the server executes them.
 */
export function isReadOnlySql(sql: string): boolean {
	const statements = splitStatements(neutralizeSql(sql));
	if (statements.length === 0) return false;
	for (const statement of statements) {
		if (!isReadStatement(statement)) return false;
	}
	return true;
}

function isReadStatement(statement: string): boolean {
	const keyword = readStartKeyword(statement);
	if (keyword === null) return false;
	return !hasWriteKeyword(statement);
}

function readStartKeyword(statement: string): string | null {
	let rest = stripExplainWrappers(statement).trim();
	rest = rest.replace(/^(?:\(\s*)+/, "");
	const match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
	const word = match?.[1]?.toUpperCase();
	if (word === undefined || !READ_START.has(word)) return null;
	return word;
}

function stripExplainWrappers(sql: string): string {
	let rest = sql.trim();
	while (/^(?:\(\s*)*EXPLAIN\b/i.test(rest)) {
		rest = rest.replace(/^(?:\(\s*)+/, "").trim();
		if (!/^EXPLAIN\b/i.test(rest)) break;
		rest = rest.replace(/^EXPLAIN\b/i, "").trim();
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const pattern of [
				/^ANALYZE\b/i,
				/^VERBOSE\b/i,
				/^QUERY\s+PLAN\b/i,
			]) {
				const next = rest.replace(pattern, "").trim();
				if (next !== rest) {
					rest = next;
					progressed = true;
				}
			}
		}
		if (!rest.startsWith("(")) continue;
		const end = indexOfClosingParen(rest, 0);
		if (end === -1) break;
		const inner = rest.slice(1, end).trim();
		if (
			/^(SELECT|WITH|VALUES|TABLE|PRAGMA|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(
				inner,
			)
		) {
			break;
		}
		rest = rest.slice(end + 1).trim();
	}
	return rest.trim();
}

function hasWriteKeyword(sql: string): boolean {
	const writeKeyword =
		/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|VACUUM|REINDEX|ATTACH|DETACH|UPSERT|REPLACE|INTO)\b/gi;
	for (const match of sql.matchAll(writeKeyword)) {
		const word = match[1]?.toUpperCase();
		const index = match.index;
		if (word === undefined || index === undefined) continue;
		const after = sql.slice(index + word.length).trimStart();
		if (after.startsWith("(")) continue;
		if (word === "REPLACE" && !/^INTO\b/i.test(after)) continue;
		if (word === "UPDATE" && isLockOrAction(sql, index)) continue;
		if (word === "DELETE" && precedingWord(sql, index) === "ON") continue;
		return true;
	}
	return false;
}

function isLockOrAction(sql: string, index: number): boolean {
	const previous = precedingWord(sql, index);
	return previous === "FOR" || previous === "ON" || previous === "KEY";
}

function precedingWord(sql: string, index: number): string {
	const before = sql.slice(0, index).trimEnd();
	const match = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
	return match?.[1]?.toUpperCase() ?? "";
}

function splitStatements(sql: string): string[] {
	return sql
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

function indexOfClosingParen(sql: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < sql.length; i++) {
		const ch = sql[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function neutralizeSql(sql: string): string {
	const chars = sql.split("");
	const blank = (from: number, to: number): void => {
		for (let j = from; j < to && j < chars.length; j++) {
			const ch = chars[j];
			if (ch !== "\n" && ch !== "\r") chars[j] = " ";
		}
	};
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === "-" && sql[i + 1] === "-") {
			let j = i + 2;
			while (j < sql.length && sql[j] !== "\n") j++;
			blank(i, j);
			i = j;
			continue;
		}
		if (ch === "/" && sql[i + 1] === "*") {
			if (sql[i + 2] === "!") {
				let j = i + 3;
				while (j < sql.length && /\d/.test(sql[j] ?? "")) j++;
				blank(i, j);
				const close = sql.indexOf("*/", j);
				if (close === -1) {
					i = sql.length;
					continue;
				}
				blank(close, close + 2);
				i = j;
				continue;
			}
			const end = scanBlockComment(sql, i);
			blank(i, end);
			i = end;
			continue;
		}
		if (ch === "'") {
			const end = scanSingleQuoted(sql, i);
			blank(i, end);
			i = end;
			continue;
		}
		if (ch === '"') {
			const end = scanDoubleQuoted(sql, i);
			blank(i, end);
			i = end;
			continue;
		}
		if (ch === BACKTICK) {
			const end = scanBacktickQuoted(sql, i);
			blank(i, end);
			i = end;
			continue;
		}
		if (ch === "[") {
			const end = sql.indexOf("]", i + 1);
			const close = end === -1 ? sql.length : end + 1;
			blank(i, close);
			i = close;
			continue;
		}
		if (ch === "$") {
			const end = scanDollarQuoted(sql, i);
			if (end !== -1) {
				blank(i, end);
				i = end;
				continue;
			}
		}
		i++;
	}
	return chars.join("");
}

function scanBlockComment(sql: string, start: number): number {
	const close = sql.indexOf("*/", start + 2);
	if (close === -1) return sql.length;
	return close + 2;
}
