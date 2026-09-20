import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioMetaResponse } from "../api";
import { navigate, tableLink, useStudio } from "../state";

type Item = { label: string; hint: string; run: () => void };

export function CommandPalette({
	meta,
}: {
	meta: StudioMetaResponse;
}): React.JSX.Element | null {
	const { paletteOpen, setPaletteOpen, toggleTheme, refreshMeta } =
		useStudio();
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (paletteOpen) {
			setQuery("");
			setIndex(0);
			setTimeout(() => inputRef.current?.focus(), 0);
		}
	}, [paletteOpen]);

	const items = useMemo<Item[]>(() => {
		const q = query.trim().toLowerCase();
		const tables = Object.keys(meta.tables)
			.sort()
			.filter((a) => a.toLowerCase().includes(q))
			.map<Item>((a) => ({
				label: `Table: ${a}`,
				hint: "data",
				run: () => navigate(tableLink(a)),
			}));
		const views: Item[] = [
			{
				label: "Go: SQL console",
				hint: "view",
				run: () => navigate("#/sql"),
			},
			{
				label: "Go: Query playground",
				hint: "view",
				run: () => navigate("#/query"),
			},
			{
				label: "Go: Schema explorer",
				hint: "view",
				run: () => navigate("#/schema"),
			},
			{
				label: "Go: ER graph",
				hint: "view",
				run: () => navigate("#/er"),
			},
			{
				label: "Go: Migrate status",
				hint: "view",
				run: () => navigate("#/migrate"),
			},
		].filter((v) => v.label.toLowerCase().includes(q));
		const actions: Item[] = [
			{ label: "Toggle theme", hint: "action", run: toggleTheme },
			{
				label: "Refresh schema",
				hint: "action",
				run: () => void refreshMeta(),
			},
		].filter((v) => v.label.toLowerCase().includes(q));
		return [...tables.slice(0, 12), ...views, ...actions].slice(0, 20);
	}, [meta, query, toggleTheme, refreshMeta]);

	if (!paletteOpen) return null;
	return (
		<div className="fixed inset-0 z-50 p-4">
			<button
				type="button"
				className="absolute inset-0 bg-black/60"
				aria-label="Close command palette"
				onClick={() => setPaletteOpen(false)}
			/>
			<div className="relative z-10 mx-auto mt-24 max-w-lg overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl">
				<input
					ref={inputRef}
					className="h-11 w-full bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
					placeholder="Type a table, view, or action…"
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setIndex(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "Escape") setPaletteOpen(false);
						if (e.key === "ArrowDown") {
							e.preventDefault();
							setIndex((i) => Math.min(i + 1, items.length - 1));
						}
						if (e.key === "ArrowUp") {
							e.preventDefault();
							setIndex((i) => Math.max(i - 1, 0));
						}
						if (e.key === "Enter" && items[index]) {
							items[index].run();
							setPaletteOpen(false);
						}
					}}
				/>
				<ul className="max-h-72 overflow-auto border-t border-border p-1">
					{items.map((item, i) => (
						<li key={item.label}>
							<button
								type="button"
								className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm ${i === index ? "bg-accent text-accent-foreground" : ""}`}
								onMouseEnter={() => setIndex(i)}
								onClick={() => {
									item.run();
									setPaletteOpen(false);
								}}
							>
								<span className="flex-1">{item.label}</span>
								<span className="text-[11px] text-muted-foreground">
									{item.hint}
								</span>
							</button>
						</li>
					))}
					{items.length === 0 ? (
						<li className="px-3 py-4 text-sm text-muted-foreground">
							No matches.
						</li>
					) : null}
				</ul>
			</div>
		</div>
	);
}
