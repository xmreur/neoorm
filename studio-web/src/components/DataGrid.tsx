import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	api,
	formatCell,
	isTextKind,
	navigationWhere,
	StudioApiError,
	type StudioColumnMeta,
	type StudioMetaResponse,
	type StudioTableMeta,
} from "../api";
import { navigate, tableLink, useStudio } from "../state";
import { CellEditor, CellView } from "./CellEditors";
import { cn } from "./lib";
import { RowSheet } from "./RowSheet";
import {
	Badge,
	Button,
	Dialog,
	Empty,
	Field,
	Input,
	Select,
	Spinner,
	Textarea,
} from "./ui";

type Filter = {
	id: number;
	column: string;
	op: string;
	value: string;
	not: boolean;
	insensitive: boolean;
};
type SaveState = { saving: boolean; error: string | null };

const TEXT_OPS = [
	"contains",
	"startsWith",
	"endsWith",
	"equals",
	"search",
	"in",
	"isNull",
	"isNotNull",
];
const SCALAR_OPS = [
	"equals",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"isNull",
	"isNotNull",
];
const ENUM_OPS = ["equals", "in", "isNull", "isNotNull"];
const JSON_OPS = [
	"jsonContains",
	"hasKey",
	"path",
	"equals",
	"isNull",
	"isNotNull",
];

function opsFor(column: StudioColumnMeta): string[] {
	if (column.kind === "bool") return ENUM_OPS;
	if (column.kind === "json" || column.kind === "jsonb") return JSON_OPS;
	if (
		column.kind === "enum" ||
		column.kind.endsWith("Array") ||
		column.kind === "enumArray"
	)
		return ENUM_OPS;
	if (
		isTextKind(column.kind) ||
		column.kind === "timestamp" ||
		column.kind === "date" ||
		column.kind === "time"
	) {
		return column.kind === "timestamp" ||
			column.kind === "date" ||
			column.kind === "time"
			? SCALAR_OPS
			: TEXT_OPS;
	}
	return SCALAR_OPS;
}

function parseFilterValue(
	column: StudioColumnMeta,
	op: string,
	raw: string,
	insensitive: boolean,
): unknown {
	if (op === "isNull") return { isNull: true };
	if (op === "isNotNull") return { isNotNull: true };
	const trimmed = raw.trim();
	const withMode = (predicate: Record<string, unknown>): unknown =>
		insensitive && isTextKind(column.kind)
			? { ...predicate, mode: "insensitive" }
			: predicate;
	if (op === "in") {
		try {
			const parsed = JSON.parse(
				trimmed.startsWith("[") ? trimmed : `[${trimmed}]`,
			) as unknown[];
			return { in: parsed };
		} catch {
			return { in: trimmed.split(",").map((s) => s.trim()) };
		}
	}
	if (op === "jsonContains") {
		try {
			return { jsonContains: JSON.parse(trimmed) as unknown };
		} catch {
			return { jsonContains: trimmed };
		}
	}
	if (op === "hasKey" || op === "path") return { [op]: trimmed };
	if (op === "search") return withMode({ search: trimmed });
	if (column.kind === "bool") {
		if (trimmed === "true") return true;
		if (trimmed === "false") return false;
		if (trimmed === "null") return null;
		return trimmed;
	}
	if (
		[
			"int",
			"serial",
			"real",
			"double",
			"decimal",
			"numeric",
			"money",
			"bigint",
		].includes(column.kind)
	) {
		if (trimmed === "") return null;
		const n = Number(trimmed);
		if (op === "equals") return Number.isFinite(n) ? n : trimmed;
		return { [op]: Number.isFinite(n) ? n : trimmed };
	}
	if (op === "equals")
		return insensitive && isTextKind(column.kind)
			? { equals: trimmed, mode: "insensitive" }
			: trimmed;
	if (
		(op === "contains" || op === "startsWith" || op === "endsWith") &&
		insensitive
	)
		return { [op]: trimmed, mode: "insensitive" };
	return { [op]: trimmed };
}

function filtersToWhere(
	table: StudioTableMeta,
	filters: Filter[],
	mode: "AND" | "OR",
): Record<string, unknown> | undefined {
	const parts: Record<string, unknown>[] = [];
	for (const f of filters) {
		const column = table.columns.find((c) => c.tsName === f.column);
		if (!column) continue;
		const predicate = parseFilterValue(
			column,
			f.op,
			f.value,
			f.insensitive,
		);
		const clause = f.not
			? { NOT: { [f.column]: predicate } }
			: { [f.column]: predicate };
		parts.push(clause);
	}
	if (parts.length === 0) return undefined;
	if (parts.length === 1) return parts[0];
	return { [mode]: parts };
}

function parseAdvancedWhere(text: string): Record<string, unknown> | undefined {
	if (!text.trim()) return undefined;
	const parsed: unknown = JSON.parse(text);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed)
	) {
		throw new Error("Advanced where must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function uniqueWhereFor(
	table: StudioTableMeta,
	row: Record<string, unknown>,
): Record<string, unknown> | null {
	for (const group of table.uniqueKeys) {
		const where: Record<string, unknown> = {};
		let ok = true;
		for (const col of group) {
			const v = row[col];
			if (v === undefined || v === null) {
				ok = false;
				break;
			}
			where[col] = v;
		}
		if (ok) return where;
	}
	return null;
}

function rowKeyFor(
	table: StudioTableMeta,
	row: Record<string, unknown>,
	index: number,
): string {
	const where = uniqueWhereFor(table, row);
	return where ? JSON.stringify(where) : `__idx:${index}`;
}

function valuesEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function download(filename: string, content: string, mime: string): void {
	const blob = new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

function rowsToCsv(columns: string[], rows: Record<string, unknown>[]): string {
	const esc = (v: string): string =>
		/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
	const lines = [columns.map(esc).join(",")];
	for (const row of rows) {
		lines.push(
			columns
				.map((c) => {
					const v = row[c];
					if (v === null || v === undefined) return "";
					if (typeof v === "string") return esc(v);
					if (typeof v === "number" || typeof v === "boolean")
						return String(v);
					return esc(JSON.stringify(v) ?? "");
				})
				.join(","),
		);
	}
	return `${lines.join("\n")}\n`;
}

export function DataGrid({
	accessor,
	meta,
}: {
	accessor: string;
	meta: StudioMetaResponse;
}): React.JSX.Element {
	const { route } = useStudio();
	const table = meta.tables[accessor];
	const mustTable = (): StudioTableMeta => {
		if (!table) throw new Error(`Unknown table "${accessor}"`);
		return table;
	};
	const [rows, setRows] = useState<Record<string, unknown>[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const initialParams =
		route.view === "tables" && route.accessor === accessor
			? route.params
			: new URLSearchParams();
	const [search, setSearch] = useState(() => initialParams.get("q") ?? "");
	const [filters, setFilters] = useState<Filter[]>([]);
	const [filterMode, setFilterMode] = useState<"AND" | "OR">("AND");
	const [showFilters, setShowFilters] = useState(false);
	const [advancedWhere, setAdvancedWhere] = useState(
		() => initialParams.get("where") ?? "",
	);
	const [advancedParsed, setAdvancedParsed] = useState<
		Record<string, unknown> | undefined
	>(() => {
		try {
			return parseAdvancedWhere(initialParams.get("where") ?? "");
		} catch {
			return undefined;
		}
	});
	const [advancedError, setAdvancedError] = useState<string | null>(null);
	const [orderBy, setOrderBy] = useState<Record<string, string>>(() => {
		try {
			return initialParams.get("orderBy")
				? (JSON.parse(initialParams.get("orderBy") ?? "{}") as Record<
						string,
						string
					>)
				: {};
		} catch {
			return {};
		}
	});
	const [take, setTake] = useState(50);
	const [skip, setSkip] = useState(() => {
		const n = Number.parseInt(initialParams.get("skip") ?? "0", 10);
		return Number.isFinite(n) && n >= 0 ? n : 0;
	});
	const [wrap, setWrap] = useState(false);
	const [hiddenCols, setHiddenCols] = useState<string[]>([]);
	const [colOrder, setColOrder] = useState<string[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>(
		{},
	);
	const [newRows, setNewRows] = useState<
		{ id: string; data: Record<string, unknown> }[]
	>([]);
	const [newRowOpen, setNewRowOpen] = useState(false);
	const [sheetRow, setSheetRow] = useState<{
		row: Record<string, unknown>;
		index: number;
	} | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [saveState, setSaveState] = useState<SaveState>({
		saving: false,
		error: null,
	});
	const [editingCell, setEditingCell] = useState<{
		key: string;
		col: string;
	} | null>(null);
	const [filterId, setFilterId] = useState(1);
	const scrollRef = useRef<HTMLDivElement>(null);

	const readOnly = meta.readOnly;

	const handleAdvancedWhere = (value: string): void => {
		setAdvancedWhere(value);
		if (!value.trim()) {
			setAdvancedParsed(undefined);
			setAdvancedError(null);
			return;
		}
		try {
			setAdvancedParsed(parseAdvancedWhere(value));
			setAdvancedError(null);
		} catch {
			setAdvancedError("Advanced where is not a valid JSON object");
		}
	};

	const where = useMemo(() => {
		if (!table) return undefined;
		const base = filtersToWhere(table, filters, filterMode);
		if (!advancedParsed || Object.keys(advancedParsed).length === 0)
			return base;
		return base ? { AND: [base, advancedParsed] } : advancedParsed;
	}, [table, filters, filterMode, advancedParsed]);

	const fetchRows = useCallback(async () => {
		if (!table) return;
		setLoading(true);
		setError(null);
		try {
			const params: Record<string, string> = {
				take: String(take),
				skip: String(skip),
			};
			if (where) params.where = JSON.stringify(where);
			if (Object.keys(orderBy).length > 0)
				params.orderBy = JSON.stringify(orderBy);
			if (search.trim()) params.q = search.trim();
			const result = await api.rows(accessor, params);
			setRows(result.rows);
			setTotal(result.total);
			setSelected(new Set());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [table, accessor, take, skip, where, orderBy, search]);

	useEffect(() => {
		void fetchRows();
	}, [fetchRows]);

	useEffect(() => {
		const params = new URLSearchParams();
		if (where) params.set("where", JSON.stringify(where));
		if (Object.keys(orderBy).length > 0)
			params.set("orderBy", JSON.stringify(orderBy));
		if (search.trim()) params.set("q", search.trim());
		if (skip > 0) params.set("skip", String(skip));
		const suffix = params.toString();
		window.history.replaceState(
			null,
			"",
			`#/tables/${encodeURIComponent(accessor)}${suffix ? `?${suffix}` : ""}`,
		);
	}, [accessor, where, orderBy, search, skip]);

	const columns = useMemo(() => {
		if (!table) return [];
		const base = colOrder
			? [...table.columns].sort(
					(a, b) =>
						colOrder.indexOf(a.tsName) - colOrder.indexOf(b.tsName),
				)
			: table.columns;
		return base.filter((c) => !hiddenCols.includes(c.tsName));
	}, [table, colOrder, hiddenCols]);

	const relationColumns = useMemo(() => {
		if (!table) return [];
		return table.relations.filter((r) => r.cardinality === "many" || r.m2m);
	}, [table]);

	const dirtyCount = Object.keys(edits).length + newRows.length;

	const setCellEdit = (key: string, col: string, value: unknown): void => {
		setEdits((prev) => {
			const rowEdits = { ...(prev[key] ?? {}) };
			const original = rows.find(
				(r, i) => rowKeyFor(mustTable(), r, i) === key,
			)?.[col];
			if (valuesEqual(value, original)) delete rowEdits[col];
			else rowEdits[col] = value;
			const next = { ...prev };
			if (Object.keys(rowEdits).length === 0) delete next[key];
			else next[key] = rowEdits;
			return next;
		});
	};

	const saveAll = useCallback(async (): Promise<void> => {
		if (!table || dirtyCount === 0 || saveState.saving) return;
		setSaveState({ saving: true, error: null });
		try {
			for (const item of newRows) {
				await api.create(accessor, { data: item.data });
			}
			for (const [key, data] of Object.entries(edits)) {
				const original = rows.find(
					(r, i) => rowKeyFor(table, r, i) === key,
				);
				const whereClause = original
					? uniqueWhereFor(table, original)
					: null;
				if (!whereClause)
					throw new Error(
						"A row has no unique key; reload and retry",
					);
				await api.update(accessor, { where: whereClause, data });
			}
			setEdits({});
			setNewRows([]);
			await fetchRows();
		} catch (err) {
			setSaveState({
				saving: false,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		setSaveState({ saving: false, error: null });
	}, [
		accessor,
		dirtyCount,
		edits,
		fetchRows,
		newRows,
		rows,
		saveState.saving,
		table,
	]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				void saveAll();
			}
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") {
				e.preventDefault();
				void fetchRows();
			}
			if (e.altKey && e.key.toLowerCase() === "n") {
				e.preventDefault();
				if (!readOnly) setNewRowOpen(true);
			}
			if (e.key === "Escape") {
				const target = e.target as HTMLElement | null;
				const tag = target?.tagName;
				if (
					tag === "INPUT" ||
					tag === "TEXTAREA" ||
					tag === "SELECT" ||
					editingCell
				)
					return;
				setEdits({});
				setNewRows([]);
				setSaveState({ saving: false, error: null });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [saveAll, fetchRows, readOnly, editingCell]);

	const deleteRows = async (keys: string[]): Promise<void> => {
		if (
			!window.confirm(
				`Delete ${keys.length} row(s)? This cannot be undone.`,
			)
		)
			return;
		setSaveState({ saving: true, error: null });
		try {
			for (const key of keys) {
				const row = rows.find(
					(r, i) => rowKeyFor(mustTable(), r, i) === key,
				);
				if (!row) continue;
				const whereClause = uniqueWhereFor(mustTable(), row);
				if (!whereClause)
					throw new Error(
						"A row has no unique key and cannot be deleted",
					);
				await api.remove(accessor, { where: whereClause });
			}
			await fetchRows();
		} catch (err) {
			setSaveState({
				saving: false,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		setSaveState({ saving: false, error: null });
	};

	const toggleSort = (col: string, additive: boolean): void => {
		setSkip(0);
		setOrderBy((prev) => {
			const current = prev[col];
			const next = { ...(additive ? prev : {}) };
			if (current === "asc") next[col] = "desc";
			else if (current === "desc") delete next[col];
			else next[col] = "asc";
			return next;
		});
	};

	const allVisibleKeys = rows.map((r, i) => rowKeyFor(mustTable(), r, i));
	const allSelected =
		allVisibleKeys.length > 0 &&
		allVisibleKeys.every((k) => selected.has(k));

	const copySelection = (format: "csv" | "md" | "json" | "sql"): void => {
		const picked = rows.filter((r, i) =>
			selected.has(rowKeyFor(mustTable(), r, i)),
		);
		if (picked.length === 0) return;
		const cols = columns.map((c) => c.tsName);
		if (format === "json") {
			download(
				`${accessor}.json`,
				JSON.stringify(picked, null, 2),
				"application/json",
			);
		} else if (format === "csv") {
			download(`${accessor}.csv`, rowsToCsv(cols, picked), "text/csv");
		} else if (format === "md") {
			const head = `| ${cols.join(" | ")} |`;
			const div = `| ${cols.map(() => "---").join(" | ")} |`;
			const body = picked.map(
				(r) =>
					`| ${cols.map((c) => formatCell(r[c]).replaceAll("|", "\\|"))} |`,
			);
			download(
				`${accessor}.md`,
				[head, div, ...body].join("\n"),
				"text/markdown",
			);
		} else {
			const lines = picked.map((r) => {
				const vals = cols.map((c) => {
					const v = r[c];
					if (v === null || v === undefined) return "NULL";
					if (typeof v === "string")
						return `'${v.replaceAll("'", "''")}'`;
					if (typeof v === "number" || typeof v === "boolean")
						return String(v);
					return `'${(JSON.stringify(v) ?? "").replaceAll("'", "''")}'`;
				});
				return `INSERT INTO "${mustTable().sqlName}" (${cols.map((c) => `"${mustTable().columns.find((col) => col.tsName === c)?.sqlName ?? c}"`).join(", ")}) VALUES (${vals.join(", ")});`;
			});
			download(`${accessor}.sql`, `${lines.join("\n")}\n`, "text/plain");
		}
	};

	const rowVirtual = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => (wrap ? 64 : 36),
		overscan: 10,
	});

	if (!table)
		return (
			<Empty
				title={`Unknown table "${accessor}"`}
				hint="It may have been removed from the schema. Pick another table from the sidebar."
			/>
		);

	const page = Math.floor(skip / take) + 1;
	const pageCount = Math.max(1, Math.ceil(total / take));

	return (
		<div className="flex h-full flex-col gap-2 p-3">
			<div className="flex flex-wrap items-center gap-2">
				<h1 className="mono text-base font-semibold">{accessor}</h1>
				<Badge title="SQL table name">{table.sqlName}</Badge>
				{table.junction ? (
					<Badge title="Auto-generated many-to-many junction table">
						junction
					</Badge>
				) : null}
				{!table.mutable ? (
					<Badge title="No unique key: browse and create only">
						read-only rows
					</Badge>
				) : null}
				<span className="text-xs text-muted-foreground">
					{total.toLocaleString()} row{total === 1 ? "" : "s"}
				</span>
				<div className="ml-auto flex flex-wrap items-center gap-1.5">
					<Input
						className="w-52"
						placeholder="Search table…"
						value={search}
						onChange={(e) => {
							setSearch(e.target.value);
							setSkip(0);
						}}
					/>
					<Button
						variant={showFilters ? "secondary" : "outline"}
						size="sm"
						onClick={() => setShowFilters((v) => !v)}
					>
						Filters
						{filters.length > 0 ? ` (${filters.length})` : ""}
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => void fetchRows()}
					>
						Refresh
					</Button>
					{!readOnly && table.mutable !== false ? (
						<Button
							size="sm"
							title="Alt+N"
							onClick={() => setNewRowOpen(true)}
						>
							New row
						</Button>
					) : null}
				</div>
			</div>

			{showFilters ? (
				<FilterPanel
					table={table}
					filters={filters}
					mode={filterMode}
					advancedWhere={advancedWhere}
					advancedError={advancedError}
					onAdd={() => {
						const first = table.columns[0];
						if (first)
							setFilters((f) => [
								...f,
								{
									id: filterId,
									column: first.tsName,
									op: opsFor(first)[0] ?? "equals",
									value: "",
									not: false,
									insensitive: false,
								},
							]);
						setFilterId((n) => n + 1);
					}}
					onChange={setFilters}
					onMode={setFilterMode}
					onAdvanced={handleAdvancedWhere}
					onClear={() => {
						setFilters([]);
						handleAdvancedWhere("");
					}}
				/>
			) : null}

			{(dirtyCount > 0 || saveState.error) && (
				<div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
					<span>
						<strong>{dirtyCount}</strong> unsaved change
						{dirtyCount === 1 ? "" : "s"}
					</span>
					{saveState.error ? (
						<span className="text-xs text-destructive">
							{saveState.error}
						</span>
					) : null}
					<div className="ml-auto flex gap-1.5">
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								setEdits({});
								setNewRows([]);
								setSaveState({ saving: false, error: null });
							}}
						>
							Discard (Esc)
						</Button>
						<Button
							size="sm"
							disabled={saveState.saving}
							onClick={() => void saveAll()}
						>
							{saveState.saving ? "Saving…" : "Save (⌘S)"}
						</Button>
					</div>
				</div>
			)}

			{error ? (
				<p className="rounded-md border border-destructive px-3 py-2 text-xs text-destructive">
					{error}
				</p>
			) : null}

			<div className="flex items-center gap-1.5 text-xs">
				<Button
					variant="outline"
					size="sm"
					onClick={() => setWrap((w) => !w)}
				>
					{wrap ? "Truncate" : "Wrap"}
				</Button>
				<ColumnMenu
					table={table}
					hidden={hiddenCols}
					onChange={setHiddenCols}
					onReorder={setColOrder}
				/>
				{selected.size > 0 ? (
					<>
						<span className="text-muted-foreground">
							{selected.size} selected
						</span>
						<Button
							variant="outline"
							size="sm"
							onClick={() => copySelection("csv")}
						>
							Copy CSV
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => copySelection("md")}
						>
							MD
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => copySelection("json")}
						>
							JSON
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => copySelection("sql")}
						>
							SQL
						</Button>
						{!readOnly ? (
							<Button
								variant="destructive"
								size="sm"
								onClick={() => void deleteRows([...selected])}
							>
								Delete
							</Button>
						) : null}
					</>
				) : null}
				<div className="ml-auto flex items-center gap-1.5">
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							window.open(
								api.exportUrl(accessor, { format: "json" }),
								"_blank",
							)
						}
					>
						Export
					</Button>
					{!readOnly ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setImportOpen(true)}
						>
							Import
						</Button>
					) : null}
				</div>
			</div>

			<div
				ref={scrollRef}
				className="min-h-0 flex-1 overflow-auto rounded-md border border-border"
			>
				<table className="w-full border-collapse text-sm">
					<thead className="sticky top-0 z-10 bg-muted">
						<tr>
							<th className="w-9 border-b border-border p-1.5">
								<input
									type="checkbox"
									checked={allSelected}
									onChange={(e) => {
										if (e.target.checked)
											setSelected(
												new Set(allVisibleKeys),
											);
										else setSelected(new Set());
									}}
									aria-label="Select all rows"
								/>
							</th>
							{columns.map((col) => (
								<th
									key={col.tsName}
									draggable
									onDragStart={(e) =>
										e.dataTransfer.setData(
											"text/col",
											col.tsName,
										)
									}
									onDragOver={(e) => e.preventDefault()}
									onDrop={(e) => {
										e.preventDefault();
										const from =
											e.dataTransfer.getData("text/col");
										if (!from || from === col.tsName)
											return;
										setColOrder((prev) => {
											const order =
												prev ??
												table.columns.map(
													(c) => c.tsName,
												);
											const next = order.filter(
												(c) => c !== from,
											);
											next.splice(
												order.indexOf(col.tsName),
												0,
												from,
											);
											return next;
										});
									}}
									className="mono border-b border-border px-2 py-1.5 text-left text-xs font-medium"
									title={`${col.kind}${col.sqlName !== col.tsName ? ` → ${col.sqlName}` : ""}${col.nullable ? " (nullable)" : ""} — click to sort, Shift+click for multi-sort, drag to reorder`}
								>
									<button
										type="button"
										className="cursor-pointer"
										onClick={(e) =>
											toggleSort(col.tsName, e.shiftKey)
										}
									>
										<span className="inline-flex items-center gap-1">
											{col.tsName}
											{col.hidden ? (
												<span title="Hidden column (visible in Studio)">
													🙈
												</span>
											) : null}
											{col.primary ? (
												<span title="Primary key">
													🔑
												</span>
											) : null}
											{col.unique && !col.primary ? (
												<span title="Unique">◆</span>
											) : null}
											{col.generated ? (
												<span title="Generated (serial/identity)">
													⚙
												</span>
											) : null}
											{orderBy[col.tsName] === "asc"
												? " ▲"
												: orderBy[col.tsName] === "desc"
													? " ▼"
													: ""}
										</span>
									</button>
									<span className="ml-1 font-normal text-muted-foreground">
										{col.kind}
									</span>
								</th>
							))}
							{relationColumns.map((rel) => (
								<th
									key={rel.name}
									className="border-b border-border px-2 py-1.5 text-left text-xs font-medium text-muted-foreground"
								>
									{rel.name} →
								</th>
							))}
							<th className="w-20 border-b border-border p-1.5" />
						</tr>
					</thead>
					<tbody>
						{loading &&
						rows.length === 0 &&
						newRows.length === 0 ? (
							<tr>
								<td
									colSpan={columns.length + 3}
									className="p-6 text-center"
								>
									<Spinner />
								</td>
							</tr>
						) : null}
						{!loading &&
						rows.length === 0 &&
						newRows.length === 0 ? (
							<tr>
								<td colSpan={columns.length + 3}>
									<Empty
										title="No rows"
										hint="Adjust filters or search, or create the first row."
									/>
								</td>
							</tr>
						) : null}
						{newRows.map((item) => (
							<tr
								key={`new:${item.id}`}
								className="border-b border-border bg-accent/30"
							>
								<td className="p-1.5 text-center">
									<span className="text-[10px] text-muted-foreground">
										new
									</span>
								</td>
								{columns.map((col) => {
									const value = item.data[col.tsName];
									const isEditing =
										editingCell?.key === `new:${item.id}` &&
										editingCell?.col === col.tsName;
									return (
										<td
											key={col.tsName}
											className="max-w-72 px-2 py-1 align-top"
											onDoubleClick={() => {
												if (
													!readOnly &&
													!col.generated &&
													!col.updatedAt
												)
													setEditingCell({
														key: `new:${item.id}`,
														col: col.tsName,
													});
											}}
										>
											{isEditing ? (
												<CellEditor
													column={col}
													value={value}
													onCommit={(v) => {
														setNewRows((prev) =>
															prev.map((row) =>
																row.id ===
																item.id
																	? {
																			...row,
																			data: {
																				...row.data,
																				[col.tsName]:
																					v,
																			},
																		}
																	: row,
															),
														);
														setEditingCell(null);
													}}
													onCancel={() =>
														setEditingCell(null)
													}
												/>
											) : (
												<CellView
													value={value}
													column={col}
													wrap={wrap}
												/>
											)}
										</td>
									);
								})}
								{relationColumns.map((rel) => (
									<td
										key={rel.name}
										className="px-2 py-1 text-xs text-muted-foreground"
									>
										{rel.name}
									</td>
								))}
								<td className="p-1.5 text-right">
									<Button
										variant="ghost"
										size="sm"
										title="Discard new row"
										onClick={() =>
											setNewRows((prev) =>
												prev.filter(
													(row) => row.id !== item.id,
												),
											)
										}
									>
										🗑
									</Button>
								</td>
							</tr>
						))}
						{(() => {
							const items = rowVirtual.getVirtualItems();
							const paddingTop = items[0]?.start ?? 0;
							const last = items[items.length - 1];
							const paddingBottom =
								rowVirtual.getTotalSize() - (last?.end ?? 0);
							const colSpan = columns.length + 3;
							return (
								<>
									{paddingTop > 0 ? (
										<tr>
											<td
												colSpan={colSpan}
												style={{
													height: paddingTop,
													padding: 0,
													border: "none",
												}}
											/>
										</tr>
									) : null}
									{items.map((virtual) => {
										const row = rows[virtual.index];
										if (!row) return null;
										const key = rowKeyFor(
											table,
											row,
											virtual.index,
										);
										const rowEdits = edits[key] ?? {};
										const isSelected = selected.has(key);
										return (
											<tr
												key={key}
												className={cn(
													"border-b border-border hover:bg-accent/40",
													isSelected &&
														"bg-accent/60",
													Object.keys(rowEdits)
														.length > 0 &&
														"bg-accent/30",
												)}
												onClick={() =>
													setSheetRow({
														row: {
															...row,
															...rowEdits,
														},
														index: virtual.index,
													})
												}
											>
												<td
													className="p-1.5 text-center"
													onClick={(e) =>
														e.stopPropagation()
													}
													onKeyDown={(e) =>
														e.stopPropagation()
													}
												>
													<input
														type="checkbox"
														checked={isSelected}
														onChange={(e) => {
															setSelected(
																(prev) => {
																	const next =
																		new Set(
																			prev,
																		);
																	if (
																		e.target
																			.checked
																	)
																		next.add(
																			key,
																		);
																	else
																		next.delete(
																			key,
																		);
																	return next;
																},
															);
														}}
														aria-label="Select row"
													/>
												</td>
												{columns.map((col) => {
													const value =
														rowEdits[col.tsName] !==
														undefined
															? rowEdits[
																	col.tsName
																]
															: row[col.tsName];
													const dirty =
														rowEdits[col.tsName] !==
														undefined;
													const fkRel =
														table.relations.find(
															(r) =>
																r.fkColumn ===
																	col.tsName &&
																r.cardinality ===
																	"one" &&
																!r.m2m,
														);
													const isEditing =
														editingCell?.key ===
															key &&
														editingCell?.col ===
															col.tsName;
													return (
														<td
															key={col.tsName}
															className={cn(
																"max-w-72 px-2 py-1 align-top",
																dirty &&
																	"bg-accent",
															)}
															onClick={(e) =>
																e.stopPropagation()
															}
															onKeyDown={(e) => {
																e.stopPropagation();
																if (
																	e.key ===
																		"Enter" &&
																	!readOnly &&
																	!col.generated &&
																	!col.updatedAt
																)
																	setEditingCell(
																		{
																			key,
																			col: col.tsName,
																		},
																	);
															}}
															onDoubleClick={() => {
																if (
																	!readOnly &&
																	!col.generated &&
																	!col.updatedAt
																)
																	setEditingCell(
																		{
																			key,
																			col: col.tsName,
																		},
																	);
															}}
														>
															{isEditing ? (
																<CellEditor
																	column={col}
																	value={
																		value
																	}
																	onCommit={(
																		v,
																	) => {
																		setCellEdit(
																			key,
																			col.tsName,
																			v,
																		);
																		setEditingCell(
																			null,
																		);
																	}}
																	onCancel={() =>
																		setEditingCell(
																			null,
																		)
																	}
																/>
															) : (
																<span className="flex items-start gap-1">
																	<span className="min-w-0 flex-1">
																		<CellView
																			value={
																				value
																			}
																			column={
																				col
																			}
																			wrap={
																				wrap
																			}
																		/>
																	</span>
																	{fkRel &&
																	value !==
																		null &&
																	value !==
																		undefined ? (
																		<button
																			type="button"
																			title={`Open ${fkRel.targetAccessor}`}
																			className="shrink-0 text-primary hover:underline"
																			onClick={() => {
																				const nav =
																					navigationWhere(
																						meta,
																						table,
																						{
																							...row,
																							...rowEdits,
																						},
																						fkRel,
																					);
																				if (
																					nav
																				)
																					navigate(
																						tableLink(
																							nav.accessor,
																							{
																								where: nav.where,
																							},
																						),
																					);
																			}}
																		>
																			→
																		</button>
																	) : null}
																</span>
															)}
														</td>
													);
												})}
												{relationColumns.map((rel) => (
													<td
														key={rel.name}
														className="px-2 py-1 align-top"
														onClick={(e) =>
															e.stopPropagation()
														}
														onKeyDown={(e) =>
															e.stopPropagation()
														}
													>
														<button
															type="button"
															className="text-xs text-primary hover:underline"
															onClick={() => {
																const nav =
																	navigationWhere(
																		meta,
																		table,
																		{
																			...row,
																			...rowEdits,
																		},
																		rel,
																	);
																if (nav)
																	navigate(
																		tableLink(
																			nav.accessor,
																			{
																				where: nav.where,
																			},
																		),
																	);
																else
																	window.alert(
																		"Row has no usable key for this relation",
																	);
															}}
														>
															View →
														</button>
													</td>
												))}
												<td
													className="p-1.5 text-right"
													onClick={(e) =>
														e.stopPropagation()
													}
													onKeyDown={(e) =>
														e.stopPropagation()
													}
												>
													{!readOnly &&
													table.mutable ? (
														<Button
															variant="ghost"
															size="sm"
															title="Delete row"
															onClick={() =>
																void deleteRows(
																	[key],
																)
															}
														>
															🗑
														</Button>
													) : null}
												</td>
											</tr>
										);
									})}
									{paddingBottom > 0 ? (
										<tr>
											<td
												colSpan={colSpan}
												style={{
													height: paddingBottom,
													padding: 0,
													border: "none",
												}}
											/>
										</tr>
									) : null}
								</>
							);
						})()}
					</tbody>
				</table>
			</div>

			<div className="flex items-center gap-2 text-xs">
				<Button
					variant="outline"
					size="sm"
					disabled={skip === 0}
					onClick={() => setSkip((s) => Math.max(0, s - take))}
				>
					← Prev
				</Button>
				<span>
					Page {page} of {pageCount}
				</span>
				<Button
					variant="outline"
					size="sm"
					disabled={skip + take >= total}
					onClick={() => setSkip((s) => s + take)}
				>
					Next →
				</Button>
				<Select
					value={String(take)}
					onChange={(e) => {
						setTake(Number(e.target.value));
						setSkip(0);
					}}
				>
					{[25, 50, 100, 200].map((n) => (
						<option key={n} value={n}>
							{n} / page
						</option>
					))}
				</Select>
				<span className="text-muted-foreground">
					Double-click a cell to edit • ⌘S saves • Esc discards via
					the banner
				</span>
			</div>

			<NewRowDialog
				open={newRowOpen}
				table={table}
				onClose={() => setNewRowOpen(false)}
				onCreate={async (data) => {
					setNewRows((prev) => [
						...prev,
						{ id: crypto.randomUUID(), data },
					]);
					setNewRowOpen(false);
				}}
			/>
			<ImportDialog
				open={importOpen}
				accessor={accessor}
				onClose={() => setImportOpen(false)}
				onDone={() => {
					setImportOpen(false);
					void fetchRows();
				}}
			/>
			{sheetRow ? (
				<RowSheet
					meta={meta}
					table={table}
					row={sheetRow.row}
					onClose={() => setSheetRow(null)}
					onChanged={() => {
						setSheetRow(null);
						void fetchRows();
					}}
				/>
			) : null}
		</div>
	);
}

function ColumnMenu({
	table,
	hidden,
	onChange,
	onReorder,
}: {
	table: StudioTableMeta;
	hidden: string[];
	onChange: (h: string[]) => void;
	onReorder: (o: string[] | null) => void;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	return (
		<span className="relative">
			<Button
				variant="outline"
				size="sm"
				onClick={() => setOpen((v) => !v)}
			>
				Columns
			</Button>
			{open ? (
				<span className="absolute left-0 top-8 z-20 flex max-h-72 w-56 flex-col gap-1 overflow-auto rounded-md border border-border bg-popover p-2 shadow-xl">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							onChange([]);
							onReorder(null);
						}}
					>
						Reset columns
					</Button>
					{table.columns.map((c) => (
						<label
							key={c.tsName}
							className="flex items-center gap-2 px-1 text-xs"
						>
							<input
								type="checkbox"
								checked={!hidden.includes(c.tsName)}
								onChange={(e) => {
									if (e.target.checked)
										onChange(
											hidden.filter(
												(h) => h !== c.tsName,
											),
										);
									else onChange([...hidden, c.tsName]);
								}}
							/>
							<span className="mono">{c.tsName}</span>
							<span className="text-muted-foreground">
								{c.kind}
							</span>
						</label>
					))}
				</span>
			) : null}
		</span>
	);
}

function FilterPanel(props: {
	table: StudioTableMeta;
	filters: Filter[];
	mode: "AND" | "OR";
	advancedWhere: string;
	advancedError: string | null;
	onAdd: () => void;
	onChange: (f: Filter[]) => void;
	onMode: (m: "AND" | "OR") => void;
	onAdvanced: (v: string) => void;
	onClear: () => void;
}): React.JSX.Element {
	const { table, filters } = props;
	return (
		<div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
			<div className="flex items-center gap-2">
				<span className="text-xs font-medium">Match</span>
				<Select
					value={props.mode}
					onChange={(e) =>
						props.onMode(e.target.value as "AND" | "OR")
					}
				>
					<option value="AND">ALL (AND)</option>
					<option value="OR">ANY (OR)</option>
				</Select>
				<Button variant="outline" size="sm" onClick={props.onAdd}>
					+ Add filter
				</Button>
				<div className="ml-auto">
					<Button variant="ghost" size="sm" onClick={props.onClear}>
						Clear
					</Button>
				</div>
			</div>
			{filters.map((f) => {
				const column = table.columns.find((c) => c.tsName === f.column);
				return (
					<div
						key={f.id}
						className="flex flex-wrap items-center gap-1.5"
					>
						<Select
							value={f.column}
							onChange={(e) =>
								props.onChange(
									filters.map((x) =>
										x.id === f.id
											? {
													...x,
													column: e.target.value,
													op: "equals",
													value: "",
												}
											: x,
									),
								)
							}
						>
							{table.columns.map((c) => (
								<option key={c.tsName} value={c.tsName}>
									{c.tsName} ({c.kind})
								</option>
							))}
						</Select>
						<Select
							value={f.op}
							onChange={(e) =>
								props.onChange(
									filters.map((x) =>
										x.id === f.id
											? { ...x, op: e.target.value }
											: x,
									),
								)
							}
						>
							{(column ? opsFor(column) : ["equals"]).map(
								(op) => (
									<option key={op} value={op}>
										{op}
									</option>
								),
							)}
						</Select>
						{f.op !== "isNull" && f.op !== "isNotNull" ? (
							<Input
								className="w-56"
								placeholder="value…"
								value={f.value}
								onChange={(e) =>
									props.onChange(
										filters.map((x) =>
											x.id === f.id
												? {
														...x,
														value: e.target.value,
													}
												: x,
										),
									)
								}
							/>
						) : null}
						<label className="flex items-center gap-1 text-xs">
							<input
								type="checkbox"
								checked={f.not}
								onChange={(e) =>
									props.onChange(
										filters.map((x) =>
											x.id === f.id
												? {
														...x,
														not: e.target.checked,
													}
												: x,
										),
									)
								}
							/>
							NOT
						</label>
						{column &&
						isTextKind(column.kind) &&
						[
							"contains",
							"startsWith",
							"endsWith",
							"equals",
							"search",
						].includes(f.op) ? (
							<label className="flex items-center gap-1 text-xs">
								<input
									type="checkbox"
									checked={f.insensitive}
									onChange={(e) =>
										props.onChange(
											filters.map((x) =>
												x.id === f.id
													? {
															...x,
															insensitive:
																e.target
																	.checked,
														}
													: x,
											),
										)
									}
								/>
								insensitive
							</label>
						) : null}
						<Button
							variant="ghost"
							size="sm"
							onClick={() =>
								props.onChange(
									filters.filter((x) => x.id !== f.id),
								)
							}
						>
							✕
						</Button>
					</div>
				);
			})}
			<Field label="Advanced where (JSON, AND-ed with the pills above)">
				<Textarea
					rows={2}
					placeholder='{"posts": {"some": {"published": true}}} or {"OR": [...]}'
					value={props.advancedWhere}
					onChange={(e) => props.onAdvanced(e.target.value)}
				/>
			</Field>
			{props.advancedError ? (
				<span className="text-xs text-destructive">
					{props.advancedError}
				</span>
			) : null}
		</div>
	);
}

function NewRowDialog({
	open,
	table,
	onClose,
	onCreate,
}: {
	open: boolean;
	table: StudioTableMeta;
	onClose: () => void;
	onCreate: (data: Record<string, unknown>) => Promise<void>;
}): React.JSX.Element {
	const editable = table.columns.filter((c) => !c.generated && !c.updatedAt);
	const [data, setData] = useState<Record<string, unknown>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (open) {
			setData({});
			setError(null);
		}
	}, [open]);
	return (
		<Dialog
			open={open}
			onClose={onClose}
			title={`New ${table.accessor} row`}
			wide
		>
			<div className="flex flex-col gap-3">
				{editable.map((col) => (
					<div key={col.tsName} className="flex flex-col gap-1">
						<span className="mono text-xs font-medium">
							{col.tsName}{" "}
							<span className="font-normal text-muted-foreground">
								({col.kind}
								{col.nullable ? ", nullable" : ""}
								{col.defaultNow ? ", default now" : ""})
							</span>
						</span>
						<InlineCreateEditor
							key={col.tsName}
							column={col}
							value={data[col.tsName]}
							onChange={(v) =>
								setData((prev) => {
									const next = { ...prev };
									if (v === undefined)
										delete next[col.tsName];
									else next[col.tsName] = v;
									return next;
								})
							}
						/>
					</div>
				))}
				{error ? (
					<span className="text-xs text-destructive">{error}</span>
				) : null}
				<div className="flex justify-end gap-2">
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						disabled={saving}
						onClick={() => {
							setSaving(true);
							setError(null);
							onCreate(data)
								.catch((err: unknown) => {
									setError(
										err instanceof StudioApiError
											? `${err.code}: ${err.message}`
											: err instanceof Error
												? err.message
												: String(err),
									);
								})
								.finally(() => setSaving(false));
						}}
					>
						{saving ? "Creating…" : "Create"}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}

function InlineCreateEditor({
	column,
	value,
	onChange,
}: {
	column: StudioColumnMeta;
	value: unknown;
	onChange: (v: unknown) => void;
}): React.JSX.Element {
	const [text, setText] = useState("");
	if (column.kind === "bool") {
		return (
			<Select
				value={value === true ? "true" : value === false ? "false" : ""}
				onChange={(e) =>
					onChange(
						e.target.value === ""
							? undefined
							: e.target.value === "true",
					)
				}
			>
				<option value="">— (default)</option>
				<option value="true">true</option>
				<option value="false">false</option>
			</Select>
		);
	}
	return (
		<Input
			placeholder={
				column.nullable ? "NULL (leave empty)" : `${column.kind}…`
			}
			value={typeof value === "string" ? value : (text ?? "")}
			onChange={(e) => {
				setText(e.target.value);
				onChange(e.target.value === "" ? undefined : e.target.value);
			}}
		/>
	);
}

function ImportDialog({
	open,
	accessor,
	onClose,
	onDone,
}: {
	open: boolean;
	accessor: string;
	onClose: () => void;
	onDone: () => void;
}): React.JSX.Element {
	const [tab, setTab] = useState<"csv" | "json">("csv");
	const [text, setText] = useState("");
	const [skipDuplicates, setSkipDuplicates] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<number | null>(null);
	return (
		<Dialog
			open={open}
			onClose={onClose}
			title={`Import into ${accessor}`}
			wide
		>
			<div className="flex flex-col gap-2">
				<div className="flex gap-1 text-xs">
					<Button
						variant={tab === "csv" ? "secondary" : "ghost"}
						size="sm"
						onClick={() => setTab("csv")}
					>
						CSV (header row)
					</Button>
					<Button
						variant={tab === "json" ? "secondary" : "ghost"}
						size="sm"
						onClick={() => setTab("json")}
					>
						JSON array
					</Button>
				</div>
				<Textarea
					rows={10}
					placeholder={
						tab === "csv"
							? "email,name\n"
							: '[{"email": "a@b.com"}]'
					}
					value={text}
					onChange={(e) => setText(e.target.value)}
				/>
				<label className="flex items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={skipDuplicates}
						onChange={(e) => setSkipDuplicates(e.target.checked)}
					/>
					Skip duplicate keys (ON CONFLICT DO NOTHING)
				</label>
				{error ? (
					<span className="text-xs text-destructive">{error}</span>
				) : null}
				{result !== null ? (
					<span className="text-xs text-muted-foreground">
						Imported {result} row(s).
					</span>
				) : null}
				<div className="flex justify-end gap-2">
					<Button variant="outline" onClick={onClose}>
						Close
					</Button>
					<Button
						disabled={busy || !text.trim()}
						onClick={() => {
							setBusy(true);
							setError(null);
							const body =
								tab === "csv"
									? { accessor, csv: text, skipDuplicates }
									: (() => {
											try {
												return {
													accessor,
													rows: JSON.parse(
														text,
													) as unknown,
													skipDuplicates,
												};
											} catch {
												setError("Invalid JSON");
												setBusy(false);
												return null;
											}
										})();
							if (!body) return;
							api.importRows(body)
								.then((r) => {
									setResult(r.count);
									onDone();
								})
								.catch((err: unknown) =>
									setError(
										err instanceof Error
											? err.message
											: String(err),
									),
								)
								.finally(() => setBusy(false));
						}}
					>
						{busy ? "Importing…" : "Import"}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}
