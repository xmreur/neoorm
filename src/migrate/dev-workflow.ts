import { join } from "node:path";
import {
	compileSchemaToManifest,
	type GenerateOptions,
	type GenerateResult,
	generateFromSchema,
	isMissingMigrationNameError,
	readSnapshot,
} from "../codegen/generate.js";
import type { Dialect } from "../dialect/types.js";
import type { DatabaseClient } from "../runtime/driver.js";
import { withMigrateDevLock } from "./dev-lock.js";
import { migrateDeploy, reconcilePendingCreates } from "./runner.js";

export type MigrateDevEvent =
	| { type: "pending-reconciled"; names: readonly string[] }
	| { type: "pending-applied"; names: readonly string[] }
	| { type: "no-pending" }
	| {
			type: "generated";
			summary: GenerateResult["summary"];
			warnings: readonly string[];
	  }
	| { type: "new-migration-reconciled"; names: readonly string[] }
	| { type: "new-migration-applied"; names: readonly string[] };

export type MigrateDevOptions = {
	client: DatabaseClient;
	dialect: Dialect;
	schemaPath: string;
	outDir: string;
	generateOptions: GenerateOptions;
	promptMigrationName?: () => Promise<string>;
	onProgress: (event: MigrateDevEvent) => void;
};

export type MigrateDevResult = {
	destructiveBlocked: boolean;
};

export async function runMigrateDev(
	options: MigrateDevOptions,
): Promise<MigrateDevResult> {
	const { client, dialect, schemaPath, outDir, generateOptions, onProgress } =
		options;
	const migrationsDir = join(outDir, "migrations");

	return withMigrateDevLock(outDir, async () => {
		const snapshotManifest = await readSnapshot(outDir);
		const compiled = await compileSchemaToManifest(
			schemaPath,
			generateOptions,
		);
		const recorded = await reconcilePendingCreates(
			client,
			dialect,
			migrationsDir,
			{
				target: compiled.manifest,
				outDir,
				schemaPath,
				...(generateOptions.acceptDataLoss
					? { acceptDataLoss: true }
					: {}),
				...(generateOptions.schema
					? { schema: generateOptions.schema }
					: {}),
			},
		);
		if (recorded.length > 0) {
			onProgress({ type: "pending-reconciled", names: recorded });
		}

		const applied = await migrateDeploy(client, dialect, migrationsDir, {
			...(generateOptions.schema
				? { schema: generateOptions.schema }
				: {}),
			schemaPath,
			...(snapshotManifest ? { manifest: snapshotManifest } : {}),
		});
		if (applied.length > 0) {
			onProgress({ type: "pending-applied", names: applied });
		} else if (recorded.length === 0) {
			onProgress({ type: "no-pending" });
		}

		let generated: GenerateResult;
		try {
			generated = await generateFromSchema(
				schemaPath,
				outDir,
				generateOptions,
			);
		} catch (err) {
			if (
				generateOptions.name ||
				!options.promptMigrationName ||
				!isMissingMigrationNameError(err)
			) {
				throw err;
			}
			const name = await options.promptMigrationName();
			generated = await generateFromSchema(schemaPath, outDir, {
				...generateOptions,
				name,
			});
		}

		onProgress({
			type: "generated",
			summary: generated.summary,
			warnings: generated.warnings,
		});

		if (generated.migrationName) {
			const newlyRecorded = await reconcilePendingCreates(
				client,
				dialect,
				migrationsDir,
				{
					target: generated.manifest,
					outDir,
					schemaPath,
					...(generateOptions.acceptDataLoss
						? { acceptDataLoss: true }
						: {}),
					...(generateOptions.schema
						? { schema: generateOptions.schema }
						: {}),
				},
			);
			if (newlyRecorded.length > 0) {
				onProgress({
					type: "new-migration-reconciled",
					names: newlyRecorded,
				});
			} else {
				const newlyApplied = await migrateDeploy(
					client,
					dialect,
					migrationsDir,
					{
						...(generateOptions.schema
							? { schema: generateOptions.schema }
							: {}),
						manifest: generated.manifest,
						schemaPath,
					},
				);
				if (newlyApplied.length > 0) {
					onProgress({
						type: "new-migration-applied",
						names: newlyApplied,
					});
				}
			}
		}

		return { destructiveBlocked: generated.destructiveBlocked };
	});
}
