import { formatCell } from "../api";

/** Read-only result table shared by the SQL console and the query playground. */
export function ResultTable({
	rows,
	cap = 200,
}: {
	rows: Record<string, unknown>[];
	cap?: number;
}): React.JSX.Element {
	const shown = rows.slice(0, cap);
	const columns = Array.from(new Set(shown.flatMap((r) => Object.keys(r))));
	if (rows.length === 0)
		return <p className="p-3 text-xs text-muted-foreground">No rows.</p>;
	return (
		<div className="overflow-auto rounded-md border border-border">
			<table className="w-full border-collapse text-xs">
				<thead className="sticky top-0 bg-muted">
					<tr>
						{columns.map((c) => (
							<th
								key={c}
								className="mono border-b border-border px-2 py-1.5 text-left font-medium"
							>
								{c}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{shown.map((row, i) => (
						<tr
							// biome-ignore lint/suspicious/noArrayIndexKey: result rows are positional snapshots with no stable id
							key={i}
							className="border-b border-border hover:bg-accent/40"
						>
							{columns.map((c) => {
								const v = row[c];
								return (
									<td
										key={c}
										className="max-w-72 truncate px-2 py-1 align-top"
									>
										{v === null || v === undefined ? (
											<span className="grid-cell-null">
												NULL
											</span>
										) : (
											formatCell(v)
										)}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
			{rows.length > cap ? (
				<p className="p-2 text-[11px] text-muted-foreground">
					Showing {cap} of {rows.length} rows.
				</p>
			) : null}
		</div>
	);
}
