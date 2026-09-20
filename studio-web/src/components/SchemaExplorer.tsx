import { useEffect, useState } from "react";
import type { StudioMetaResponse } from "../api";
import { navigate, tableLink } from "../state";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Empty,
} from "./ui";

export function SchemaExplorer({
	meta,
	accessor,
}: {
	meta: StudioMetaResponse;
	accessor: string | null;
}): React.JSX.Element {
	const accessors = Object.keys(meta.tables).sort();
	const [current, setCurrent] = useState(accessor ?? accessors[0] ?? "");
	useEffect(() => {
		if (accessor && meta.tables[accessor]) setCurrent(accessor);
	}, [accessor, meta.tables]);
	const table = meta.tables[current];
	if (!table)
		return (
			<Empty
				title="No tables"
				hint="Generate the client first: bunx neoorm generate."
			/>
		);
	return (
		<div className="flex h-full flex-col gap-2 overflow-auto p-3">
			<div className="flex flex-wrap items-center gap-2">
				<h1 className="text-base font-semibold">Schema</h1>
				<span className="text-xs text-muted-foreground">
					Read-only — schema changes belong in schema.ts + migrate
					dev.
				</span>
				<select
					className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
					value={current}
					onChange={(e) => setCurrent(e.target.value)}
				>
					{accessors.map((a) => (
						<option key={a} value={a}>
							{a}
						</option>
					))}
				</select>
				<Button
					variant="outline"
					size="sm"
					onClick={() => navigate(tableLink(current))}
				>
					Open data →
				</Button>
			</div>
			<div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>
							Columns ({table.columns.length}){" "}
							{table.junction ? <Badge>junction</Badge> : null}
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="overflow-auto">
							<table className="w-full border-collapse text-xs">
								<thead>
									<tr className="text-left text-muted-foreground">
										<th className="border-b border-border px-2 py-1">
											tsName
										</th>
										<th className="border-b border-border px-2 py-1">
											sqlName
										</th>
										<th className="border-b border-border px-2 py-1">
											kind
										</th>
										<th className="border-b border-border px-2 py-1">
											flags
										</th>
									</tr>
								</thead>
								<tbody>
									{table.columns.map((c) => (
										<tr
											key={c.tsName}
											className="border-b border-border"
										>
											<td className="mono px-2 py-1 font-medium">
												{c.tsName}
											</td>
											<td className="mono px-2 py-1 text-muted-foreground">
												{c.sqlName}
											</td>
											<td className="mono px-2 py-1">
												{c.kind}
											</td>
											<td className="px-2 py-1">
												<span className="flex flex-wrap gap-1">
													{c.primary ? (
														<Badge>pk</Badge>
													) : null}
													{c.unique && !c.primary ? (
														<Badge>unique</Badge>
													) : null}
													{c.nullable ? null : (
														<Badge>not null</Badge>
													)}
													{c.hidden ? (
														<Badge title="Omitted from default selects">
															hidden
														</Badge>
													) : null}
													{c.generated ? (
														<Badge>generated</Badge>
													) : null}
													{c.defaultNow ? (
														<Badge>
															default now
														</Badge>
													) : null}
													{c.updatedAt ? (
														<Badge>updatedAt</Badge>
													) : null}
													{c.index ? (
														<Badge>index</Badge>
													) : null}
													{c.checkExpression ? (
														<Badge
															title={
																c.checkExpression
															}
														>
															check
														</Badge>
													) : null}
												</span>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</CardContent>
				</Card>
				<div className="flex flex-col gap-2">
					<Card>
						<CardHeader>
							<CardTitle>
								Relations ({table.relations.length})
							</CardTitle>
						</CardHeader>
						<CardContent>
							{table.relations.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									None.
								</p>
							) : null}
							<ul className="flex flex-col gap-1 text-xs">
								{table.relations.map((r) => (
									<li
										key={r.name}
										className="flex items-center gap-2"
									>
										<span className="mono font-medium">
											{r.name}
										</span>
										<span className="text-muted-foreground">
											→ {r.targetAccessor} (
											{r.cardinality}
											{r.m2m ? ", m2m" : ""})
										</span>
										<Button
											variant="ghost"
											size="sm"
											onClick={() =>
												navigate(
													tableLink(r.targetAccessor),
												)
											}
										>
											Open →
										</Button>
									</li>
								))}
							</ul>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>
								Indexes ({table.indexes.length}) • Unique keys (
								{table.uniqueKeys.length})
							</CardTitle>
						</CardHeader>
						<CardContent>
							{table.indexes.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									None.
								</p>
							) : null}
							<ul className="flex flex-col gap-1 text-xs">
								{table.indexes.map((idx) => (
									<li key={idx.name} className="mono">
										{idx.name} ({idx.columns.join(", ")})
										{idx.unique ? " UNIQUE" : ""}
										{idx.using ? ` USING ${idx.using}` : ""}
										{idx.whereSql ? (
											<span className="text-muted-foreground">
												{" "}
												WHERE {idx.whereSql}
											</span>
										) : null}
									</li>
								))}
							</ul>
							{table.uniqueKeys.length > 0 ? (
								<p className="mono mt-2 text-[11px] text-muted-foreground">
									unique where:{" "}
									{table.uniqueKeys
										.map((g) => `{${g.join(", ")}}`)
										.join(" • ")}
								</p>
							) : null}
						</CardContent>
					</Card>
					{table.foreignKeys.length > 0 ? (
						<Card>
							<CardHeader>
								<CardTitle>
									Foreign keys ({table.foreignKeys.length})
								</CardTitle>
							</CardHeader>
							<CardContent>
								<ul className="mono flex flex-col gap-1 text-xs">
									{table.foreignKeys.map((fk) => (
										<li key={fk.name}>
											{fk.name}: ({fk.columns.join(", ")})
											→ {fk.targetTable}(
											{fk.targetColumns.join(", ")})
											{fk.onDelete
												? ` onDelete=${fk.onDelete}`
												: ""}
											{fk.onUpdate
												? ` onUpdate=${fk.onUpdate}`
												: ""}
										</li>
									))}
								</ul>
							</CardContent>
						</Card>
					) : null}
				</div>
			</div>
		</div>
	);
}
