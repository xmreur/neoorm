import { useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { DataGrid } from "./components/DataGrid";
import { ErGraph } from "./components/ErGraph";
import { MigrateStatus } from "./components/MigrateStatus";
import { QueryPlayground } from "./components/QueryPlayground";
import { SchemaExplorer } from "./components/SchemaExplorer";
import { Sidebar } from "./components/Sidebar";
import { SqlConsole } from "./components/SqlConsole";
import { TopBar } from "./components/TopBar";
import { Button, Empty, Input, Spinner } from "./components/ui";
import { useStudio } from "./state";

export function App(): React.JSX.Element {
	const { meta, metaError, refreshMeta, route, saveToken } = useStudio();
	const [collapsed, setCollapsed] = useState(false);
	const [tokenInput, setTokenInput] = useState("");

	if (metaError && !meta) {
		const needsToken = /401|unauthorized/i.test(metaError);
		return (
			<div className="flex h-screen items-center justify-center p-4">
				<div className="flex w-full max-w-md flex-col gap-2 rounded-lg border border-border bg-card p-4">
					<h1 className="text-sm font-semibold">
						Could not connect to Studio
					</h1>
					<p className="text-xs text-muted-foreground">{metaError}</p>
					{needsToken ? (
						<div className="flex gap-2">
							<Input
								placeholder="Studio token…"
								value={tokenInput}
								onChange={(e) => setTokenInput(e.target.value)}
								onKeyDown={(e) =>
									e.key === "Enter" &&
									saveToken(tokenInput.trim())
								}
							/>
							<Button
								onClick={() => saveToken(tokenInput.trim())}
							>
								Save
							</Button>
						</div>
					) : (
						<Button size="sm" onClick={() => void refreshMeta()}>
							Retry
						</Button>
					)}
				</div>
			</div>
		);
	}

	if (!meta) {
		return (
			<div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
				<Spinner /> <span className="ml-2">Loading Studio…</span>
			</div>
		);
	}

	const accessors = Object.keys(meta.tables).sort();
	const tableAccessor =
		route.view === "tables"
			? route.accessor && meta.tables[route.accessor]
				? route.accessor
				: (accessors[0] ?? null)
			: null;

	return (
		<div className="flex h-screen flex-col">
			<TopBar meta={meta} />
			{meta.metaSource === "snapshot" ? (
				<p className="border-b border-border bg-card px-3 py-1.5 text-xs">
					schema.ts did not compile; Studio is showing snapshot.json
					and may be stale. Fix schema.ts and restart, or run{" "}
					<span className="mono">neoorm generate</span>.
				</p>
			) : null}
			<div className="flex min-h-0 flex-1">
				{(route.view === "tables" || route.view === "schema") && (
					<Sidebar
						meta={meta}
						collapsed={collapsed}
						onToggle={() => setCollapsed((v) => !v)}
					/>
				)}
				<main className="min-w-0 flex-1">
					{route.view === "tables" ? (
						tableAccessor ? (
							<DataGrid
								key={tableAccessor}
								accessor={tableAccessor}
								meta={meta}
							/>
						) : (
							<Empty
								title="No tables"
								hint="Generate the client first: bunx neoorm generate."
							/>
						)
					) : route.view === "sql" ? (
						<SqlConsole meta={meta} />
					) : route.view === "query" ? (
						<QueryPlayground meta={meta} />
					) : route.view === "schema" ? (
						<SchemaExplorer meta={meta} accessor={route.accessor} />
					) : route.view === "er" ? (
						<ErGraph />
					) : (
						<MigrateStatus />
					)}
				</main>
			</div>
			<CommandPalette meta={meta} />
		</div>
	);
}
