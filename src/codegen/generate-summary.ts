import type {
	DestructiveChange,
	Manifest,
	ManifestDiff,
} from "../dialect/types.js";
import {
	explainNoMigrationSql,
	formatDestructiveWarnings,
	isManualDestructiveChange,
} from "./diff-manifest.js";

export type GenerateStatus =
	| "unchanged"
	| "codegen_only"
	| "migration_created"
	| "migration_blocked";

export type GenerateSummary = {
	status: GenerateStatus;
	schemaChanged: boolean;
	migrationName: string | null;
	sqlStatementCount: number;
	reasons: string[];
	blocked: DestructiveChange[];
};

export function summarizeGenerateOutcome(params: {
	prev: Manifest | null;
	next: Manifest;
	diff: ManifestDiff;
	sql: string[];
	blocked: DestructiveChange[];
	schemaChanged: boolean;
	migrationName: string | null;
	acceptDataLoss?: boolean;
}): GenerateSummary {
	const {
		prev,
		next,
		diff,
		sql,
		blocked,
		schemaChanged,
		migrationName,
		acceptDataLoss,
	} = params;

	if (!schemaChanged) {
		return {
			status: "unchanged",
			schemaChanged: false,
			migrationName: null,
			sqlStatementCount: 0,
			reasons: [
				"Snapshot matches schema — no manifest or migration changes.",
			],
			blocked: [],
		};
	}

	if (migrationName !== null) {
		const reasons = [
			`Wrote ${sql.length} SQL statement(s) to "${migrationName}".`,
		];
		const manualBlocked = blocked.filter((change) =>
			isManualDestructiveChange(change.kind),
		);
		if (manualBlocked.length > 0) {
			reasons.push(
				...formatDestructiveWarnings(manualBlocked).map(
					(message) =>
						`Skipped (manual migration required): ${message}`,
				),
			);
		}
		return {
			status: "migration_created",
			schemaChanged: true,
			migrationName,
			sqlStatementCount: sql.length,
			reasons,
			blocked,
		};
	}

	if (blocked.length > 0) {
		const reasons = [...formatDestructiveWarnings(blocked)];
		// The flag does not emit enum value removals or reorders, unsafe casts, or NOT NULL
		// changes that need a backfill. Once it has already been passed,
		// telling the user to pass it again is wrong.
		const needsAcceptDataLoss = blocked.some(
			(change) => !isManualDestructiveChange(change.kind),
		);
		if (!acceptDataLoss && needsAcceptDataLoss) {
			reasons.push("Re-run: neoorm generate --accept-data-loss");
		}
		return {
			status: "migration_blocked",
			schemaChanged: true,
			migrationName: null,
			sqlStatementCount: 0,
			reasons,
			blocked,
		};
	}

	return {
		status: "codegen_only",
		schemaChanged: true,
		migrationName: null,
		sqlStatementCount: 0,
		reasons: explainNoMigrationSql(prev, next, diff),
		blocked: [],
	};
}

export function formatGenerateSummary(
	summary: GenerateSummary,
	outDir: string,
	options?: { zod?: boolean; typebox?: boolean; elysia?: boolean },
): string[] {
	const lines: string[] = [];

	switch (summary.status) {
		case "unchanged":
			lines.push(
				"✓ Snapshot matches schema — client regenerated, no migration changes.",
			);
			lines.push(`  Regenerated client at ${outDir}/client.ts`);
			break;
		case "codegen_only":
			lines.push(
				"✓ Client regenerated — manifest changed, no database migration needed.",
			);
			if (summary.reasons.length > 0) {
				lines.push("  Reasons:");
				for (const reason of summary.reasons) {
					lines.push(`    • ${reason}`);
				}
			}
			lines.push(
				`  Updated ${outDir}/manifest.ts, ${outDir}/snapshot.json`,
			);
			break;
		case "migration_created":
			lines.push(
				`✓ Created migration ${summary.migrationName} (${summary.sqlStatementCount} statement(s))`,
			);
			lines.push(`  Generated client at ${outDir}/client.ts`);
			lines.push(`  Generated manifest at ${outDir}/manifest.ts`);
			if (summary.reasons.length > 1) {
				for (const reason of summary.reasons.slice(1)) {
					lines.push(`  • ${reason}`);
				}
			}
			break;
		case "migration_blocked":
			lines.push(
				"✗ No migration written — blocked changes require attention.",
			);
			for (const reason of summary.reasons) {
				if (reason.startsWith("Re-run:")) {
					lines.push(`  ${reason}`);
				} else {
					lines.push(`  • ${reason}`);
				}
			}
			lines.push(`  Generated client at ${outDir}/client.ts`);
			lines.push(`  Generated manifest at ${outDir}/manifest.ts`);
			if (
				summary.reasons.some((reason) => reason.startsWith("Re-run:"))
			) {
				lines.push(
					`  Snapshot not updated at ${outDir}/snapshot.json — re-run with --accept-data-loss to write migration SQL`,
				);
			} else {
				lines.push(`  Snapshot not updated at ${outDir}/snapshot.json`);
			}
			break;
		default: {
			const _exhaustive: never = summary.status;
			return [_exhaustive];
		}
	}

	if (options?.zod === true) {
		lines.push(`  Generated Zod schemas at ${outDir}/zod.ts`);
	}
	if (options?.typebox === true) {
		lines.push(`  Generated TypeBox schemas at ${outDir}/typebox.ts`);
	}
	if (options?.elysia === true) {
		lines.push(`  Generated Elysia schemas at ${outDir}/elysia.ts`);
	}

	return lines;
}
