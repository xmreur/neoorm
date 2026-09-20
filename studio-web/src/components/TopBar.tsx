import type { StudioMetaResponse } from "../api";
import { navigate, useStudio } from "../state";
import { cn } from "./lib";
import { Badge, Button, Kbd } from "./ui";

const VIEWS = [
	{ id: "tables", label: "Data" },
	{ id: "sql", label: "SQL" },
	{ id: "query", label: "Query" },
	{ id: "schema", label: "Schema" },
	{ id: "er", label: "ER" },
	{ id: "migrate", label: "Migrate" },
] as const;

export function TopBar({
	meta,
}: {
	meta: StudioMetaResponse;
}): React.JSX.Element {
	const { route, theme, toggleTheme, setPaletteOpen } = useStudio();
	const active = route.view;
	return (
		<header className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5">
			<span className="text-sm font-bold">
				NeoOrm{" "}
				<span className="font-normal text-muted-foreground">
					Studio
				</span>
			</span>
			<nav className="flex gap-0.5">
				{VIEWS.map((v) => (
					<button
						key={v.id}
						type="button"
						onClick={() =>
							navigate(
								v.id === "tables" ? "#/tables" : `#/${v.id}`,
							)
						}
						className={cn(
							"rounded px-2.5 py-1 text-xs font-medium",
							active === v.id
								? "bg-accent text-accent-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{v.label}
					</button>
				))}
			</nav>
			<span className="ml-auto flex items-center gap-1.5">
				{meta.readOnly ? (
					<Badge title="Mutations and write SQL are blocked">
						read-only
					</Badge>
				) : null}
				{meta.metaSource === "snapshot" ? (
					<Badge title="schema.ts did not compile; showing snapshot.json">
						snapshot
					</Badge>
				) : null}
				<Badge title={`Provider: ${meta.provider ?? "unknown"}`}>
					{meta.dialect}
				</Badge>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setPaletteOpen(true)}
					title="Command palette"
				>
					<Kbd>⌘K</Kbd>
				</Button>
				<Button
					variant="ghost"
					size="icon"
					onClick={toggleTheme}
					title={theme === "dark" ? "Light mode" : "Dark mode"}
				>
					{theme === "dark" ? "☀" : "☾"}
				</Button>
			</span>
		</header>
	);
}
