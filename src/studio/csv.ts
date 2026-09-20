/** Minimal CSV parse/serialize for Studio import/export (no external deps). */

export function parseCsv(text: string): {
	headers: string[];
	rows: Record<string, string>[];
} {
	const cells: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let inQuotes = false;
	let i = 0;
	const pushCell = () => {
		row.push(cell);
		cell = "";
	};
	const pushRow = () => {
		pushCell();
		cells.push(row);
		row = [];
	};
	while (i < text.length) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			cell += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			i++;
			continue;
		}
		if (ch === ",") {
			pushCell();
			i++;
			continue;
		}
		if (ch === "\r") {
			i++;
			continue;
		}
		if (ch === "\n") {
			pushRow();
			i++;
			continue;
		}
		cell += ch;
		i++;
	}
	pushRow();
	while (
		cells.length > 0 &&
		cells[cells.length - 1]?.every((c) => c === "")
	) {
		cells.pop();
	}
	if (cells.length === 0) return { headers: [], rows: [] };
	const headers = (cells[0] ?? []).map((h) => h.trim());
	const rows = cells.slice(1).map((values) => {
		const record: Record<string, string> = {};
		for (let c = 0; c < headers.length; c++) {
			const header = headers[c];
			if (header !== undefined) record[header] = values[c] ?? "";
		}
		return record;
	});
	return { headers, rows };
}

function escapeCsvCell(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serialize JSON-safe rows to CSV. Markers become compact JSON strings. */
export function toCsv(
	headers: string[],
	rows: Record<string, unknown>[],
): string {
	const lines = [headers.map(escapeCsvCell).join(",")];
	for (const row of rows) {
		lines.push(
			headers
				.map((h) => {
					const value = row[h];
					if (value === null || value === undefined) return "";
					if (typeof value === "string") return escapeCsvCell(value);
					if (typeof value === "number" || typeof value === "boolean")
						return String(value);
					return escapeCsvCell(JSON.stringify(value) ?? "");
				})
				.join(","),
		);
	}
	return `${lines.join("\n")}\n`;
}

function mdCell(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "string")
		return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return `\`${(JSON.stringify(value) ?? "").replaceAll("|", "\\|")}\``;
}

/** Serialize rows to a GitHub-flavored Markdown table. */
export function toMarkdown(
	headers: string[],
	rows: Record<string, unknown>[],
): string {
	const head = `| ${headers.join(" | ")} |`;
	const divider = `| ${headers.map(() => "---").join(" | ")} |`;
	const body = rows.map(
		(row) => `| ${headers.map((h) => mdCell(row[h])).join(" | ")} |`,
	);
	return [head, divider, ...body].join("\n");
}

function sqlLiteral(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (typeof value === "number")
		return Number.isFinite(value) ? String(value) : "NULL";
	if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
	if (
		typeof value === "object" &&
		value !== null &&
		"__neoorm" in (value as Record<string, unknown>)
	) {
		const marker = value as {
			__neoorm: string;
			value?: string;
			base64?: string;
		};
		if (marker.__neoorm === "bigint") return marker.value ?? "NULL";
		if (marker.__neoorm === "date") return `'${marker.value ?? ""}'`;
		if (marker.__neoorm === "bytes")
			return `'\\x${Buffer.from(marker.base64 ?? "", "base64").toString("hex")}'`;
	}
	return `'${(JSON.stringify(value) ?? "").replaceAll("'", "''")}'`;
}

/** Serialize rows to `INSERT` statements (dev convenience, not a migration). */
export function toSqlInserts(
	qualifiedTable: string,
	quoteIdentifier: (name: string) => string,
	sqlColumns: string[],
	tsColumns: string[],
	rows: Record<string, unknown>[],
): string {
	if (rows.length === 0) return `-- no rows\n`;
	const columns = sqlColumns.map(quoteIdentifier).join(", ");
	return rows
		.map(
			(row) =>
				`INSERT INTO ${qualifiedTable} (${columns}) VALUES (${tsColumns.map((c) => sqlLiteral(row[c])).join(", ")});`,
		)
		.join("\n");
}
