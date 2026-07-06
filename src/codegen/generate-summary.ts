import type {
	DestructiveChange,
	Manifest,
	ManifestDiff,
} from "../dialect/types.js";
import {
	explainNoMigrationSql,
	formatDestructiveWarnings,
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
}): GenerateSummary {
	const { prev, next, diff, sql, blocked, schemaChanged, migrationName } =
		params;

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
		const manualBlocked = blocked.filter(
			(change) =>
				change.kind === "alter_column_type_manual" ||
				change.kind === "alter_enum_manual",
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
		return {
			status: "migration_blocked",
			schemaChanged: true,
			migrationName: null,
			sqlStatementCount: 0,
			reasons: [
				...formatDestructiveWarnings(blocked),
				"Re-run: neoorm generate --accept-data-loss",
			],
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
): string[] {
	const lines: string[] = [];

	switch (summary.status) {
		case "unchanged":
			lines.push(
				"✓ Schema unchanged — snapshot, client, and migrations are in sync.",
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
			break;
		default: {
			const _exhaustive: never = summary.status;
			return [_exhaustive];
		}
	}

	return lines;
}
