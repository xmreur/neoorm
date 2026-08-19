export type SqlFragment = {
	readonly _kind: "fragment";
	readonly text: string;
	readonly params: readonly unknown[];
};

export type SqlValue = unknown | SqlFragment;

export function sqlFragment(text: string, params: unknown[] = []): SqlFragment {
	return { _kind: "fragment", text, params };
}

export function isSqlFragment(value: unknown): value is SqlFragment {
	return (
		typeof value === "object" &&
		value !== null &&
		"_kind" in value &&
		(value as SqlFragment)._kind === "fragment"
	);
}

function scanSingleQuoted(sql: string, start: number): number {
	let i = start + 1;
	while (i < sql.length) {
		if (sql[i] === "'") {
			if (sql[i + 1] === "'") {
				i += 2;
				continue;
			}
			return i + 1;
		}
		i++;
	}
	return sql.length;
}

function scanDoubleQuoted(sql: string, start: number): number {
	let i = start + 1;
	while (i < sql.length) {
		if (sql[i] === '"') {
			if (sql[i + 1] === '"') {
				i += 2;
				continue;
			}
			return i + 1;
		}
		i++;
	}
	return sql.length;
}

/** Index just past the closing $tag$ for a dollar-quoted region, or -1. */
function scanDollarQuoted(sql: string, start: number): number {
	const tagEnd = sql.indexOf("$", start + 1);
	if (tagEnd === -1) return -1;
	const tag = sql.slice(start + 1, tagEnd);
	if (!/^[A-Za-z_]*$/.test(tag)) return -1;
	const closing = sql.indexOf(`$${tag}$`, tagEnd + 1);
	if (closing === -1) return -1;
	return closing + tag.length + 2;
}

/**
 * Rebase `$N` parameter references by `offset` without touching text inside
 * single-quoted literals, double-quoted identifiers, or dollar-quoted regions.
 * The naive `/\$(\d+)/g` replacement rewrites `$N` that merely appears inside
 * a quoted string (e.g. `"val$1"`), corrupting the statement.
 */
export function rebaseParamRefs(sql: string, offset: number): string {
	if (offset === 0) return sql;
	let result = "";
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === "'") {
			const end = scanSingleQuoted(sql, i);
			result += sql.slice(i, end);
			i = end;
			continue;
		}
		if (ch === '"') {
			const end = scanDoubleQuoted(sql, i);
			result += sql.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "$") {
			const dollarEnd = scanDollarQuoted(sql, i);
			if (dollarEnd !== -1) {
				result += sql.slice(i, dollarEnd);
				i = dollarEnd;
				continue;
			}
			if (/\d/.test(sql[i + 1] ?? "")) {
				let j = i + 1;
				while (j < sql.length && /\d/.test(sql[j] ?? "")) j++;
				const num = Number(sql.slice(i + 1, j));
				result += `$${num + offset}`;
				i = j;
				continue;
			}
		}
		result += ch;
		i++;
	}
	return result;
}

export function sqlTag(
	strings: TemplateStringsArray,
	...values: unknown[]
): SqlFragment {
	let text = "";
	const params: unknown[] = [];
	let paramIndex = 0;

	for (let i = 0; i < strings.length; i++) {
		text += strings[i];
		if (i < values.length) {
			const value = values[i];
			if (isSqlFragment(value)) {
				const fragmentParams = [...value.params];
				const adjusted = rebaseParamRefs(value.text, paramIndex);
				text += adjusted;
				params.push(...fragmentParams);
				paramIndex += fragmentParams.length;
			} else {
				paramIndex++;
				params.push(value);
				text += `$${paramIndex}`;
			}
		}
	}

	return sqlFragment(text, params);
}

export function sqlId(name: string): SqlFragment {
	const escaped = `"${name.replace(/"/g, '""')}"`;
	return sqlFragment(escaped, []);
}

export type CompiledSql = {
	text: string;
	params: unknown[];
};

export function compile(fragment: SqlFragment): CompiledSql {
	return { text: fragment.text, params: [...fragment.params] };
}
