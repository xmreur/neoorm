import { useCallback, useEffect, useRef, useState } from "react";
import {
	api,
	isGeoKind,
	navigationWhere,
	type StudioMetaResponse,
	type StudioRelationMeta,
	type StudioTableMeta,
} from "../api";
import { navigate, tableLink } from "../state";
import { CellEditor, CellView, GeoPreview } from "./CellEditors";
import { Button, Dialog, Field, Spinner, Textarea } from "./ui";

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

export function RowSheet({
	meta,
	table,
	row,
	onClose,
	onChanged,
}: {
	meta: StudioMetaResponse;
	table: StudioTableMeta;
	row: Record<string, unknown>;
	onClose: () => void;
	onChanged: () => void;
}): React.JSX.Element {
	const [tab, setTab] = useState<"values" | "relations">("values");
	const [editing, setEditing] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const uniqueWhere = uniqueWhereFor(table, row);

	const saveCell = async (col: string, value: unknown): Promise<void> => {
		if (!uniqueWhere) {
			setError("Row has no unique key; it cannot be edited");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const updated = await api.update(table.accessor, {
				where: uniqueWhere,
				data: { [col]: value },
			});
			if (updated.row) {
				for (const [k, v] of Object.entries(updated.row)) row[k] = v;
			}
			setEditing(null);
			onChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onClose={onClose} title={`${table.accessor} row`} wide>
			<div className="mb-3 flex gap-1 text-xs">
				<Button
					variant={tab === "values" ? "secondary" : "ghost"}
					size="sm"
					onClick={() => setTab("values")}
				>
					Values
				</Button>
				<Button
					variant={tab === "relations" ? "secondary" : "ghost"}
					size="sm"
					onClick={() => setTab("relations")}
				>
					Relations ({table.relations.length})
				</Button>
			</div>
			{error ? (
				<p className="mb-2 text-xs text-destructive">{error}</p>
			) : null}
			{tab === "values" ? (
				<div className="flex flex-col gap-2">
					{table.columns.map((col) => {
						const value = row[col.tsName];
						const isEditing = editing === col.tsName;
						return (
							<div
								key={col.tsName}
								className="rounded-md border border-border p-2"
							>
								<div className="mono mb-1 flex items-center gap-2 text-xs">
									<span className="font-medium">
										{col.tsName}
									</span>
									<span className="text-muted-foreground">
										{col.kind}
										{col.sqlName !== col.tsName
											? ` → ${col.sqlName}`
											: ""}
										{col.hidden ? " • hidden" : ""}
										{col.generated ? " • generated" : ""}
									</span>
									<span className="ml-auto flex gap-1">
										{!meta.readOnly &&
										!col.generated &&
										!col.updatedAt &&
										!isEditing ? (
											<Button
												variant="ghost"
												size="sm"
												onClick={() =>
													setEditing(col.tsName)
												}
											>
												Edit
											</Button>
										) : null}
									</span>
								</div>
								{isEditing ? (
									<CellEditor
										column={col}
										value={value}
										onCommit={(v) =>
											void saveCell(col.tsName, v)
										}
										onCancel={() => setEditing(null)}
									/>
								) : (
									<div className="text-sm">
										<CellView
											value={value}
											column={col}
											wrap
										/>
									</div>
								)}
								{isGeoKind(col.kind) ? (
									<GeoPreview value={value} />
								) : null}
							</div>
						);
					})}
					{busy ? <Spinner /> : null}
				</div>
			) : (
				<div className="flex flex-col gap-3">
					{!uniqueWhere ? (
						<p className="text-xs text-muted-foreground">
							Row has no unique key; relation reads work but
							nested writes need one.
						</p>
					) : null}
					{table.relations.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							No relations.
						</p>
					) : null}
					{table.relations.map((rel) => (
						<RelationCard
							key={rel.name}
							meta={meta}
							table={table}
							row={row}
							relation={rel}
							uniqueWhere={uniqueWhere}
							onChanged={onChanged}
						/>
					))}
				</div>
			)}
		</Dialog>
	);
}

function RelationCard({
	meta,
	table,
	row,
	relation,
	uniqueWhere,
	onChanged,
}: {
	meta: StudioMetaResponse;
	table: StudioTableMeta;
	row: Record<string, unknown>;
	relation: StudioRelationMeta;
	uniqueWhere: Record<string, unknown> | null;
	onChanged: () => void;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const [related, setRelated] = useState<Record<string, unknown>[] | null>(
		null,
	);
	const [total, setTotal] = useState<number | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [payload, setPayload] = useState("{\n  \n}");
	const [action, setAction] = useState("connect");
	const loadedRef = useRef(false);

	const nav = navigationWhere(meta, table, row, relation);
	const navKey = nav ? JSON.stringify(nav) : "";

	const load = useCallback(async (): Promise<void> => {
		const parsed = (
			navKey
				? (JSON.parse(navKey) as { accessor: string; where: unknown })
				: null
		) as { accessor: string; where: Record<string, unknown> } | null;
		if (!parsed) return;
		setLoading(true);
		setError(null);
		try {
			const result = await api.rows(parsed.accessor, {
				where: JSON.stringify(parsed.where),
				take: "6",
			});
			setRelated(result.rows);
			setTotal(result.total);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [navKey]);

	useEffect(() => {
		if (open && !loadedRef.current) {
			loadedRef.current = true;
			void load();
		}
		if (!open) loadedRef.current = false;
	}, [open, load]);

	const runNested = async (): Promise<void> => {
		if (!uniqueWhere) {
			setError("Row has no unique key; nested writes need one");
			return;
		}
		let parsed: unknown;
		try {
			parsed = payload.trim() ? (JSON.parse(payload) as unknown) : {};
		} catch {
			setError("Payload is not valid JSON");
			return;
		}
		setLoading(true);
		setError(null);
		try {
			await api.update(table.accessor, {
				where: uniqueWhere,
				data: { [relation.name]: { [action]: parsed } },
			});
			setRelated(null);
			await load();
			onChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	const actions =
		relation.cardinality === "one" && !relation.m2m
			? ["connect", "connectOrCreate", "create", "disconnect"]
			: [
					"connect",
					"connectOrCreate",
					"create",
					"disconnect",
					"set",
					"delete",
				];

	return (
		<div className="rounded-md border border-border p-2">
			<div className="flex items-center gap-2 text-xs">
				<button
					type="button"
					className="mono font-medium hover:underline"
					onClick={() => setOpen((v) => !v)}
				>
					{open ? "▾" : "▸"} {relation.name}
				</button>
				<span className="text-muted-foreground">
					→ {relation.targetAccessor} ({relation.cardinality}
					{relation.m2m ? ", m2m" : ""})
				</span>
				<span className="ml-auto flex gap-1">
					{nav ? (
						<Button
							variant="ghost"
							size="sm"
							onClick={() =>
								navigate(
									tableLink(nav.accessor, {
										where: nav.where,
									}),
								)
							}
						>
							Open table →
						</Button>
					) : null}
				</span>
			</div>
			{open ? (
				<div className="mt-2 flex flex-col gap-2">
					{loading && related === null ? <Spinner /> : null}
					{error ? (
						<span className="text-xs text-destructive">
							{error}
						</span>
					) : null}
					{related !== null ? (
						<div className="flex flex-col gap-1">
							<span className="text-[11px] text-muted-foreground">
								{total ?? related.length} related row
								{(total ?? related.length) === 1 ? "" : "s"}
								{related.length < (total ?? 0)
									? ` (showing ${related.length})`
									: ""}
							</span>
							{related.slice(0, 5).map((r, i) => (
								<pre
									// biome-ignore lint/suspicious/noArrayIndexKey: related rows are positional previews with no stable key
									key={i}
									className="mono max-h-24 overflow-auto rounded bg-muted p-1.5 text-[11px]"
								>
									{JSON.stringify(r, null, 1)?.slice(0, 600)}
								</pre>
							))}
						</div>
					) : null}
					{!meta.readOnly && uniqueWhere ? (
						<div className="flex flex-col gap-1.5 rounded bg-muted p-2">
							<div className="flex items-center gap-1.5 text-xs">
								<span>Nested write:</span>
								<select
									className="h-7 rounded-md border border-input bg-transparent px-1 text-xs"
									value={action}
									onChange={(e) => setAction(e.target.value)}
								>
									{actions.map((a) => (
										<option key={a} value={a}>
											{a}
										</option>
									))}
								</select>
								<span className="ml-auto flex gap-1">
									<Button
										size="sm"
										variant="outline"
										onClick={() => setPayload("{}")}
									>
										Clear
									</Button>
									<Button
										size="sm"
										onClick={() => void runNested()}
									>
										Apply
									</Button>
								</span>
							</div>
							<Field
								label={
									action === "disconnect"
										? "Payload (empty {} disconnects all for to-many, or the one for to-one)"
										: "Payload (unique where, data, or list for set)"
								}
							>
								<Textarea
									rows={3}
									value={payload}
									onChange={(e) => setPayload(e.target.value)}
								/>
							</Field>
							<span className="text-[11px] text-muted-foreground">
								connect/disconnect/set/delete take primary keys
								(e.g. {"{"}id: 1{"}"}) • create takes row data •
								connectOrCreate takes {"{"}where, create{"}"} •
								see docs/relations.md
							</span>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
