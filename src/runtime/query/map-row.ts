import type { ManifestTable } from "../../dialect/types.js";
import {
	mapRowToTs as mapRowCore,
	mapRowsToTs as mapRowsCore,
} from "./compile.js";
import { attachStripToRows } from "./strip.js";
import type { TableIndex } from "./table-index.js";

export function mapRowToTs(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	row: Record<string, unknown>,
): Record<string, unknown> {
	const mapped = mapRowCore(tableIndex, table, row);
	if (mapped !== row) {
		attachStripToRows(tableIndex, table, mapped);
	}
	return mapped;
}

export function mapRowsToTs(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	rows: Record<string, unknown>[],
): Record<string, unknown>[] {
	const mapped = mapRowsCore(tableIndex, table, rows);
	if (!tableIndex || mapped === rows) return mapped;
	for (let i = 0; i < mapped.length; i++) {
		const out = mapped[i];
		if (out && out !== rows[i]) {
			attachStripToRows(tableIndex, table, out);
		}
	}
	return mapped;
}
