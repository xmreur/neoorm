import { useState } from "react";
import type { StudioMetaResponse } from "../api";
import { navigate, tableLink, useStudio } from "../state";
import { IconChevron, IconRefresh, IconSearch } from "./icons";
import { cn } from "./lib";
import { Button } from "./ui";

export function Sidebar({
	meta,
	collapsed,
	onToggle,
}: {
	meta: StudioMetaResponse;
	collapsed: boolean;
	onToggle: () => void;
}): React.JSX.Element {
	const { route, refreshMeta } = useStudio();
	const [search, setSearch] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [showJunctions, setShowJunctions] = useState(false);

	const tables = Object.values(meta.tables).sort((a, b) =>
		a.accessor.localeCompare(b.accessor),
	);
	const regular = tables.filter((t) => !t.junction);
	const junctions = tables.filter((t) => t.junction);
	const matches = (name: string): boolean =>
		name.toLowerCase().includes(search.trim().toLowerCase());
	const visibleRegular = regular.filter((t) => matches(t.accessor));
	const visibleJunctions = junctions.filter((t) => matches(t.accessor));

	if (collapsed) {
		return (
			<aside className="flex w-10 flex-col items-center gap-1 border-r border-border bg-background py-2">
				<Button
					variant="ghost"
					size="icon"
					onClick={onToggle}
					title="Expand sidebar"
				>
					<IconChevron direction="right" />
				</Button>
			</aside>
		);
	}

	const activeAccessor =
		route.view === "tables" || route.view === "schema"
			? route.accessor && meta.tables[route.accessor]
				? route.accessor
				: (tables[0]?.accessor ?? null)
			: null;

	const item = (accessor: string, badges: string): React.JSX.Element => {
		const active = activeAccessor === accessor;
		return (
			<button
				key={accessor}
				type="button"
				aria-current={active ? "page" : undefined}
				onClick={() =>
					navigate(
						route.view === "schema"
							? `#/schema/${encodeURIComponent(accessor)}`
							: tableLink(accessor),
					)
				}
				className={cn(
					"mono flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
					active
						? "bg-accent font-semibold text-accent-foreground"
						: "text-muted-foreground hover:bg-secondary hover:text-foreground",
				)}
			>
				<span className="truncate">{accessor}</span>
				{badges ? (
					<span
						className={cn(
							"ml-auto shrink-0 text-[10px]",
							active
								? "text-accent-foreground/80"
								: "text-muted-foreground",
						)}
					>
						{badges}
					</span>
				) : null}
			</button>
		);
	};

	return (
		<aside className="flex w-60 shrink-0 flex-col border-r border-border bg-background">
			<div className="flex items-center gap-1 border-b border-border px-3 py-2">
				<span className="text-[11px] font-bold tracking-[0.08em] text-muted-foreground uppercase">
					Tables ({tables.length})
				</span>
				<span className="ml-auto flex gap-0.5">
					<Button
						variant="ghost"
						size="icon"
						title="Search tables"
						onClick={() => setSearchOpen((v) => !v)}
					>
						<IconSearch />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						title="Refresh schema"
						onClick={() => void refreshMeta()}
					>
						<IconRefresh />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						title="Collapse sidebar"
						onClick={onToggle}
					>
						<IconChevron direction="left" />
					</Button>
				</span>
			</div>
			{searchOpen ? (
				<div className="border-b border-border p-2">
					<input
						className="h-7 w-full rounded-md border border-input bg-card px-2 text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
						placeholder="Filter tables…"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && visibleRegular[0])
								navigate(tableLink(visibleRegular[0].accessor));
							if (e.key === "Escape") setSearchOpen(false);
						}}
					/>
				</div>
			) : null}
			<nav className="min-h-0 flex-1 overflow-auto p-1.5">
				{visibleRegular.map((t) =>
					item(t.accessor, t.mutable ? "" : "ro"),
				)}
				{junctions.length > 0 ? (
					<div className="mt-1">
						<button
							type="button"
							className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground"
							onClick={() => setShowJunctions((v) => !v)}
						>
							<IconChevron
								direction={showJunctions ? "down" : "right"}
							/>
							junction tables ({visibleJunctions.length})
						</button>
						{showJunctions
							? visibleJunctions.map((t) =>
									item(t.accessor, "m2m"),
								)
							: null}
					</div>
				) : null}
				{visibleRegular.length === 0 &&
				visibleJunctions.length === 0 ? (
					<p className="p-2 text-xs text-muted-foreground">
						No tables match.
					</p>
				) : null}
			</nav>
		</aside>
	);
}
