/** SQL clause for a stored generated column. MariaDB accepts `STORED` as `PERSISTENT`. */
export function storedGeneratedSql(expression: string): string {
	return `GENERATED ALWAYS AS (${expression}) STORED`;
}

/** Trim, collapse whitespace, and strip one balanced outer parenthesis pair. */
export function normalizeGeneratedExpression(
	expression: string | undefined,
): string | undefined {
	if (expression === undefined) return undefined;
	let text = expression.trim().replace(/\s+/g, " ");
	if (text.startsWith("(") && text.endsWith(")") && wrapsOnce(text)) {
		text = text.slice(1, -1).trim().replace(/\s+/g, " ");
	}
	return text;
}

export function generatedExpressionsEqual(
	left: string | undefined,
	right: string | undefined,
): boolean {
	return (
		normalizeGeneratedExpression(left) ===
		normalizeGeneratedExpression(right)
	);
}

function wrapsOnce(text: string): boolean {
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "(") depth++;
		else if (char === ")") depth--;
		if (depth === 0 && i < text.length - 1) return false;
		if (depth < 0) return false;
	}
	return depth === 0;
}
