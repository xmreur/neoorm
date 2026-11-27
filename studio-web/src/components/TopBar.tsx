import type { StudioMetaResponse } from "../api";
import { navigate, useStudio } from "../state";
import { BrandMark } from "./BrandMark";
import { IconMoon, IconSearch, IconSun } from "./icons";
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
		<header className="studio-topbar sticky top-0 z-40 flex h-14 items-center gap-3.5 border-b border-border px-5">
			<button
				type="button"
				onClick={() => navigate("#/tables")}
				className="shrink-0 rounded-md focus-visible:outline-offset-4"
				title="NeoORM Studio"
			>
				<BrandMark />
			</button>
			<nav className="flex min-w-0 gap-0.5" aria-label="Studio views">
				{VIEWS.map((v) => (
					<button
						key={v.id}
						type="button"
						aria-current={active === v.id ? "page" : undefined}
						onClick={() =>
							navigate(
								v.id === "tables" ? "#/tables" : `#/${v.id}`,
							)
						}
						className={cn(
							"rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
							active === v.id
								? "bg-accent text-accent-foreground"
								: "text-muted-foreground hover:bg-secondary hover:text-foreground",
						)}
					>
						{v.label}
					</button>
				))}
			</nav>
			<span className="ml-auto flex shrink-0 items-center gap-1.5">
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
				<button
					type="button"
					onClick={() => setPaletteOpen(true)}
					title="Command palette"
					className="inline-flex h-[34px] items-center gap-2 rounded-md border border-border bg-card px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
				>
					<IconSearch />
					<span className="hidden lg:inline">Commands</span>
					<Kbd>⌘K</Kbd>
				</button>
				<Button
					variant="ghost"
					size="icon"
					onClick={toggleTheme}
					aria-label={
						theme === "dark"
							? "Switch to light theme"
							: "Switch to dark theme"
					}
					title={
						theme === "dark"
							? "Switch to light theme"
							: "Switch to dark theme"
					}
				>
					{theme === "dark" ? <IconMoon /> : <IconSun />}
				</Button>
			</span>
		</header>
	);
}
