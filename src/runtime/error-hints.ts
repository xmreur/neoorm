import type { Manifest, ManifestTable } from "../dialect/types.js";

export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	const rowCount = b.length + 1;
	const colCount = a.length + 1;
	const matrix: number[][] = [];
	for (let i = 0; i < rowCount; i++) {
		const row = new Array<number>(colCount);
		row[0] = i;
		matrix.push(row);
	}
	const firstRow = matrix[0];
	if (!firstRow) {
		throw new Error("levenshtein matrix initialization failed");
	}
	for (let j = 0; j < colCount; j++) {
		firstRow[j] = j;
	}

	for (let i = 1; i < rowCount; i++) {
		const row = matrix[i];
		const prev = matrix[i - 1];
		if (!row || !prev) {
			throw new Error("levenshtein matrix row missing");
		}
		for (let j = 1; j < colCount; j++) {
			const cost = a[j - 1] === b[i - 1] ? 0 : 1;
			const up = prev[j];
			const left = row[j - 1];
			const diag = prev[j - 1];
			if (up === undefined || left === undefined || diag === undefined) {
				throw new Error("levenshtein matrix cell missing");
			}
			row[j] = Math.min(up + 1, left + 1, diag + cost);
		}
	}

	const lastRow = matrix[b.length];
	if (!lastRow) {
		throw new Error("levenshtein matrix result row missing");
	}
	const distance = lastRow[a.length];
	if (distance === undefined) {
		throw new Error("levenshtein matrix result missing");
	}
	return distance;
}

function scoreCandidate(input: string, candidate: string): number {
	const lowerInput = input.toLowerCase();
	const lowerCandidate = candidate.toLowerCase();

	if (candidate === input) return 0;
	if (lowerCandidate === lowerInput) return 1;
	if (lowerCandidate.startsWith(lowerInput)) return 2;
	if (lowerCandidate.includes(lowerInput)) return 3;

	const distance = levenshtein(lowerInput, lowerCandidate);
	const maxLen = Math.max(input.length, candidate.length);
	return 10 + distance / maxLen;
}

export function didYouMean(
	input: string,
	candidates: readonly string[],
	limit = 3,
): string[] {
	if (candidates.length === 0) return [];

	const scored = candidates
		.filter((c) => c !== input)
		.map((candidate) => ({
			candidate,
			score: scoreCandidate(input, candidate),
		}))
		.sort((a, b) => a.score - b.score);

	const maxDistance = Math.max(3, Math.floor(input.length / 2));
	return scored
		.filter(({ score, candidate }) => {
			if (score <= 3) return true;
			return (
				levenshtein(input.toLowerCase(), candidate.toLowerCase()) <=
				maxDistance
			);
		})
		.slice(0, limit)
		.map(({ candidate }) => candidate);
}

export function formatCandidateList(
	candidates: readonly string[],
	max = 8,
): string {
	if (candidates.length === 0) return "";
	const shown = candidates.slice(0, max);
	const rest = candidates.length - shown.length;
	const list = shown.map((c) => `"${c}"`).join(", ");
	if (rest > 0) {
		return `${list}, …and ${rest} more`;
	}
	return list;
}

export function listTableAccessors(manifest: Manifest): string[] {
	return Object.keys(manifest.tables).sort();
}

export function listColumnTsNames(table: ManifestTable): string[] {
	return table.columns.map((col) => col.tsName).sort();
}

export function accessorFromSqlName(
	manifest: Manifest,
	sqlName: string,
): string | undefined {
	for (const table of Object.values(manifest.tables)) {
		if (table.sqlName === sqlName) {
			return table.accessor;
		}
	}
	return undefined;
}

export function resolveSqlColumnName(
	table: ManifestTable,
	name: string,
): string | undefined {
	const col = table.columns.find(
		(c) => c.sqlName === name || c.tsName === name,
	);
	if (!col || col.tsName === name) {
		return undefined;
	}
	return col.tsName;
}

export function suggestTableAccessor(
	input: string,
	accessors: readonly string[],
	manifest?: Manifest,
): string[] {
	const suggestions: string[] = [];

	if (manifest) {
		const fromSql = accessorFromSqlName(manifest, input);
		if (fromSql) {
			suggestions.push(
				`"${input}" is a SQL table name — use the schema accessor "${fromSql}" instead`,
			);
		}
	}

	suggestions.push(
		"FK and many() targets use schema accessors (camelCase), not SQL table names",
	);

	const matches = didYouMean(input, accessors);
	for (const match of matches) {
		suggestions.push(`Did you mean "${match}"?`);
	}

	if (accessors.length > 0) {
		suggestions.push(
			`Valid table accessors: ${formatCandidateList(accessors)}`,
		);
	}

	return suggestions;
}

export function suggestTsColumn(
	input: string,
	table: ManifestTable,
	label?: string,
): string[] {
	const suggestions: string[] = [];
	const columns = listColumnTsNames(table);
	const sqlMatch = resolveSqlColumnName(table, input);

	if (sqlMatch) {
		suggestions.push(
			`Query APIs use TypeScript column names — "${input}" is the SQL name for "${sqlMatch}"`,
		);
		suggestions.push(`Did you mean "${sqlMatch}"?`);
	} else {
		if (label) {
			suggestions.push(
				`Use TypeScript column names in ${label}, not SQL column names`,
			);
		}
		const matches = didYouMean(input, columns);
		for (const match of matches) {
			suggestions.push(`Did you mean "${match}"?`);
		}
	}

	if (columns.length > 0) {
		suggestions.push(
			`Valid columns on "${table.accessor}": ${formatCandidateList(columns)}`,
		);
	}

	return suggestions;
}

export function suggestWhereOperator(
	input: string,
	operators: readonly string[],
): string[] {
	const suggestions: string[] = [];
	const matches = didYouMean(input, operators);
	for (const match of matches) {
		suggestions.push(`Did you mean "${match}"?`);
	}
	if (operators.length > 0) {
		suggestions.push(`Valid operators: ${formatCandidateList(operators)}`);
	}
	return suggestions;
}

export function accessorFromSchemaSqlName(
	tables: Record<string, { readonly _tableName: string }>,
	sqlName: string,
): string | undefined {
	for (const [accessor, table] of Object.entries(tables)) {
		if (table._tableName === sqlName) {
			return accessor;
		}
	}
	return undefined;
}

export function suggestSchemaTableAccessor(
	input: string,
	tables: Record<string, { readonly _tableName: string }>,
): string[] {
	const accessors = Object.keys(tables).sort();
	const suggestions: string[] = [];

	const fromSql = accessorFromSchemaSqlName(tables, input);
	if (fromSql) {
		suggestions.push(
			`"${input}" is a SQL table name — use the schema accessor "${fromSql}" instead`,
		);
	}

	suggestions.push(
		"FK and many() targets use schema accessors (camelCase), not SQL table names",
	);

	const matches = didYouMean(input, accessors);
	for (const match of matches) {
		suggestions.push(`Did you mean "${match}"?`);
	}

	if (accessors.length > 0) {
		suggestions.push(
			`Valid table accessors: ${formatCandidateList(accessors)}`,
		);
	}

	return suggestions;
}

export function suggestSchemaColumn(
	input: string,
	columns: Record<string, unknown>,
	tableAccessor?: string,
): string[] {
	const columnNames = Object.keys(columns).sort();
	const suggestions: string[] = [];

	const matches = didYouMean(input, columnNames);
	for (const match of matches) {
		suggestions.push(`Did you mean "${match}"?`);
	}

	if (columnNames.length > 0) {
		const prefix = tableAccessor ? `on "${tableAccessor}"` : "";
		suggestions.push(
			`Valid columns ${prefix}: ${formatCandidateList(columnNames)}`,
		);
	}

	return suggestions;
}

export function suggestRelation(
	input: string,
	table: ManifestTable,
	relationNames: readonly string[],
): string[] {
	const suggestions: string[] = [
		`Use relation names as defined in the schema (e.g. fk().as("user"))`,
	];

	const matches = didYouMean(input, relationNames);
	for (const match of matches) {
		suggestions.push(`Did you mean "${match}"?`);
	}

	if (relationNames.length > 0) {
		suggestions.push(
			`Valid relations on "${table.accessor}": ${formatCandidateList(relationNames)}`,
		);
	}

	return suggestions;
}
