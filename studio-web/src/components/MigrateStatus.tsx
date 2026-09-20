import { useEffect, useState } from "react";
import { api } from "../api";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Empty,
	Spinner,
} from "./ui";

type Status =
	| { available: false; reason: string }
	| {
			available: true;
			migrationsDir: string;
			applied: {
				name: string;
				appliedAt: string;
				checksum: string | null;
			}[];
			pending: string[];
			orphanApplied: string[];
	  };

export function MigrateStatus(): React.JSX.Element {
	const [status, setStatus] = useState<Status | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api.migrateStatus()
			.then(setStatus)
			.catch((err: unknown) =>
				setError(err instanceof Error ? err.message : String(err)),
			);
	}, []);

	if (error)
		return (
			<Empty
				title="Could not load migrate status"
				hint={error}
				action={
					<Button size="sm" onClick={() => window.location.reload()}>
						Retry
					</Button>
				}
			/>
		);
	if (!status)
		return (
			<p className="p-6 text-sm text-muted-foreground">
				<Spinner /> Loading…
			</p>
		);
	if (!status.available)
		return <Empty title="Migrations unavailable" hint={status.reason} />;

	return (
		<div className="flex h-full flex-col gap-2 overflow-auto p-3">
			<div className="flex items-center gap-2">
				<h1 className="text-base font-semibold">Migrations</h1>
				<span className="mono text-xs text-muted-foreground">
					{status.migrationsDir}
				</span>
			</div>
			{status.pending.length > 0 ? (
				<p className="rounded-md border border-border bg-card px-3 py-2 text-xs">
					⚠️ {status.pending.length} pending migration(s) — the
					database schema may differ from schema.ts. Apply them with{" "}
					<span className="mono">neoorm migrate deploy</span> in your
					terminal. Studio never applies migrations itself.
				</p>
			) : (
				<p className="rounded-md border border-border bg-card px-3 py-2 text-xs">
					✓ Database is up to date with the migration ledger.
				</p>
			)}
			<div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Applied ({status.applied.length})</CardTitle>
					</CardHeader>
					<CardContent>
						{status.applied.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								None.
							</p>
						) : null}
						<ul className="flex flex-col gap-1 text-xs">
							{status.applied.map((m) => (
								<li
									key={m.name}
									className="flex items-center gap-2"
								>
									<Badge>✓</Badge>
									<span className="mono">{m.name}</span>
									<span className="text-muted-foreground">
										{new Date(m.appliedAt).toLocaleString()}
									</span>
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Pending ({status.pending.length})</CardTitle>
					</CardHeader>
					<CardContent>
						{status.pending.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								None.
							</p>
						) : null}
						<ul className="flex flex-col gap-1 text-xs">
							{status.pending.map((name) => (
								<li
									key={name}
									className="flex items-center gap-2"
								>
									<Badge>○</Badge>
									<span className="mono">{name}</span>
								</li>
							))}
						</ul>
						{status.orphanApplied.length > 0 ? (
							<div className="mt-3">
								<p className="mb-1 text-xs font-medium">
									Applied but missing on disk (
									{status.orphanApplied.length})
								</p>
								<ul className="flex flex-col gap-1 text-xs">
									{status.orphanApplied.map((name) => (
										<li
											key={name}
											className="flex items-center gap-2"
										>
											<Badge>!</Badge>
											<span className="mono">{name}</span>
										</li>
									))}
								</ul>
							</div>
						) : null}
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
