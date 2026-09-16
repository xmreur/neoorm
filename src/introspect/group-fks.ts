export type GroupedForeignKey = {
	constraintName: string;
	columns: Array<{
		columnName: string;
		foreignTable: string;
		foreignColumn: string;
	}>;
	onDelete?: string;
	onUpdate?: string;
	deferrable?: string;
};

export type GroupableFkRow = {
	constraintName: string;
	columnName: string;
	foreignTable: string;
	foreignColumn: string;
	ordinal?: number | undefined;
	onDelete?: string | undefined;
	onUpdate?: string | undefined;
	deferrable?: string | undefined;
};

export function groupForeignKeyRows(
	rows: readonly GroupableFkRow[],
): GroupedForeignKey[] {
	const grouped = new Map<string, GroupableFkRow[]>();
	for (const row of rows) {
		const list = grouped.get(row.constraintName) ?? [];
		list.push(row);
		grouped.set(row.constraintName, list);
	}
	const result: GroupedForeignKey[] = [];
	for (const [constraintName, list] of grouped) {
		list.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
		const first = list[0];
		if (!first) continue;
		const fk: GroupedForeignKey = {
			constraintName,
			columns: list.map((row) => ({
				columnName: row.columnName,
				foreignTable: row.foreignTable,
				foreignColumn: row.foreignColumn,
			})),
		};
		if (first.onDelete) fk.onDelete = first.onDelete;
		if (first.onUpdate) fk.onUpdate = first.onUpdate;
		if (first.deferrable) fk.deferrable = first.deferrable;
		result.push(fk);
	}
	return result;
}

export function mapReferentialAction(
	rule: string | null | undefined,
): string | undefined {
	if (!rule) return undefined;
	switch (rule.toUpperCase()) {
		case "CASCADE":
			return "cascade";
		case "SET NULL":
			return "set null";
		case "RESTRICT":
			return "restrict";
		case "NO ACTION":
			return "no action";
		default:
			return undefined;
	}
}
