import type { TableDef } from "./table.js";

// Maps a column builder back to the table that owns it so that
// `fk(users.id)` (a ColumnBuilder) can be resolved to a "users.id" target.
// Lives on globalThis so every module instance shares the same registry,
// mirroring the many-to-many registry pattern.
const REGISTRY_KEY = Symbol.for("neoorm.tableRegistry");

type TableRegistryEntry = {
	table: TableDef;
	columns: Record<string, unknown>;
};

function registry(): TableRegistryEntry[] {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return ((globalThis as any)[REGISTRY_KEY] ??= []);
}

export function registerTable(
	table: TableDef,
	columns: Record<string, unknown>,
): void {
	registry().push({ table, columns });
}

export function findOwningTable(
	column: unknown,
): { table: TableDef; tsName: string } | undefined {
	for (const entry of registry()) {
		for (const [tsName, col] of Object.entries(entry.columns)) {
			if (col === column) {
				return { table: entry.table, tsName };
			}
		}
	}
	return undefined;
}

export function clearTableRegistry(): void {
	registry().length = 0;
}