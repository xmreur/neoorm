/**
 * Convert `$N` placeholders to positional `?` and expand params so each `?`
 * is bound once (mysql2 does not support numbered placeholders).
 */
export function convertNumberedToPositional(
	sql: string,
	params: unknown[],
): { sql: string; params: unknown[] } {
	let out = "";
	const outParams: unknown[] = [];
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const next = sql[i + 1];

		if (inLineComment) {
			out += ch;
			if (ch === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			out += ch;
			if (ch === "*" && next === "/") {
				out += next;
				i++;
				inBlockComment = false;
			}
			continue;
		}
		if (inSingle) {
			out += ch;
			if (ch === "'") {
				if (next === "'") {
					out += next;
					i++;
				} else {
					inSingle = false;
				}
			}
			continue;
		}
		if (inDouble) {
			out += ch;
			if (ch === '"') {
				if (next === '"') {
					out += next;
					i++;
				} else {
					inDouble = false;
				}
			}
			continue;
		}
		if (inBacktick) {
			out += ch;
			if (ch === "`") {
				if (next === "`") {
					out += next;
					i++;
				} else {
					inBacktick = false;
				}
			}
			continue;
		}
		if (ch === "-" && next === "-") {
			inLineComment = true;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			out += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			out += ch;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			out += ch;
			continue;
		}
		if (ch === "`") {
			inBacktick = true;
			out += ch;
			continue;
		}
		if (ch === "$" && next !== undefined && /\d/.test(next)) {
			let j = i + 1;
			while (j < sql.length && /\d/.test(sql[j] ?? "")) j++;
			const index = Number(sql.slice(i + 1, j));
			out += "?";
			outParams.push(params[index - 1] ?? null);
			i = j - 1;
			continue;
		}
		out += ch;
	}

	return { sql: out, params: outParams };
}
