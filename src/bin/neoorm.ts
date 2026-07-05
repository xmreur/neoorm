#!/usr/bin/env node
import { Command } from "commander";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { generateFromSchema, formatGenerateSummary } from "../codegen/generate.js";
import {
  migrateDeploy,
  migrateReset,
  migrateStatus,
  formatMigrateStatus,
  dbPush,
  dbPushWarnings,
} from "../migrate/runner.js";
import { introspectPostgres } from "../introspect/pull.js";
import { writeFile } from "node:fs/promises";

const program = new Command();

program
  .name("neoorm")
  .description("NeoOrm CLI")
  .version("0.1.0");

program
  .command("generate")
  .description("Generate manifest, client, and migrations from schema")
  .option(
    "--accept-data-loss",
    "Include destructive schema changes in generated migrations",
  )
  .action(async (options: { acceptDataLoss?: boolean }) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    const schemaPath = resolve(cwd, config.schema);
    const outDir = resolve(cwd, config.out);

    const { warnings, summary } = await generateFromSchema(schemaPath, outDir, {
      ...(options.acceptDataLoss ? { acceptDataLoss: true } : {}),
      ...(config.datasource.enum ? { enumMode: config.datasource.enum } : {}),
    });

    for (const line of formatGenerateSummary(summary, outDir)) {
      console.log(line);
    }
    for (const warning of warnings) {
      console.warn(`Warning: ${warning}`);
    }
  });

program
  .command("migrate")
  .description("Run migrations")
  .argument("[subcommand]", "dev | deploy | status | reset")
  .option(
    "--accept-data-loss",
    "Include destructive schema changes in generated migrations",
  )
  .option("--force", "Required for reset — drops the public schema and all data")
  .option("--skip-apply", "With reset, only drop schema without re-applying migrations")
  .action(
    async (
      subcommand,
      options: {
        acceptDataLoss?: boolean;
        force?: boolean;
        skipApply?: boolean;
      },
    ) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      const outDir = resolve(cwd, config.out);
      const migrationsDir = join(outDir, "migrations");

      const pool = new Pool({ connectionString: config.datasource.url });

      try {
        if (subcommand === "status") {
          const status = await migrateStatus(pool, migrationsDir);
          for (const line of formatMigrateStatus(status, migrationsDir)) {
            console.log(line);
          }
          return;
        }

        if (subcommand === "reset") {
          const { reapplied } = await migrateReset(pool, migrationsDir, {
            force: options.force ?? false,
            ...(options.skipApply ? { skipApply: true } : {}),
          });
          console.log("✓ Database schema reset (public schema dropped and recreated)");
          if (options.skipApply) {
            console.log("  Skipped re-applying migrations (--skip-apply)");
          } else if (reapplied.length === 0) {
            console.log("  No migrations on disk to apply");
          } else {
            console.log(`  Re-applied ${reapplied.length} migration(s):`);
            for (const name of reapplied) {
              console.log(`    - ${name}`);
            }
          }
          return;
        }

        if (subcommand === "deploy" || subcommand === "dev") {
          const applied = await migrateDeploy(pool, migrationsDir);
          if (applied.length === 0) {
            console.log("No pending migrations");
          } else {
            console.log(`Applied ${applied.length} migration(s):`);
            for (const name of applied) {
              console.log(`  - ${name}`);
            }
          }

          if (subcommand === "dev") {
            const schemaPath = resolve(cwd, config.schema);
            const { warnings, summary, migrationName } = await generateFromSchema(
              schemaPath,
              outDir,
              {
                ...(options.acceptDataLoss ? { acceptDataLoss: true } : {}),
                ...(config.datasource.enum ? { enumMode: config.datasource.enum } : {}),
              },
            );
            for (const line of formatGenerateSummary(summary, outDir)) {
              console.log(line);
            }
            for (const warning of warnings) {
              console.warn(`Warning: ${warning}`);
            }
            if (migrationName) {
              const newlyApplied = await migrateDeploy(pool, join(outDir, "migrations"));
              if (newlyApplied.length > 0) {
                console.log(`Applied new migration: ${newlyApplied.join(", ")}`);
              }
            }
          }
          return;
        }

        console.error("Usage: neoorm migrate dev | deploy | status | reset");
        process.exit(1);
      } finally {
        await pool.end();
      }
    },
  );

program
  .command("db")
  .description("Database utilities")
  .argument("<subcommand>", "push | pull")
  .option("-o, --output <file>", "Output file for pull", "schema.pulled.ts")
  .option(
    "--accept-data-loss",
    "Apply destructive schema changes when pushing to the database",
  )
  .action(async (subcommand, options: { output?: string; acceptDataLoss?: boolean }) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    const pool = new Pool({ connectionString: config.datasource.url });

    try {
      if (subcommand === "push") {
        const outDir = resolve(cwd, config.out);
        const { readSnapshot } = await import("../codegen/generate.js");
        const manifest = await readSnapshot(outDir);
        if (!manifest) {
          console.error("Run neoorm generate first");
          process.exit(1);
        }
        const { appliedStatements, destructiveBlocked } = await dbPush(
          pool,
          manifest,
          { ...(options.acceptDataLoss ? { acceptDataLoss: true } : {}),
          },
        );
        for (const warning of dbPushWarnings(destructiveBlocked)) {
          console.warn(`Warning: ${warning}`);
        }
        if (appliedStatements === 0 && destructiveBlocked.length === 0) {
          console.log("Database schema is up to date");
        } else {
          console.log(
            `Database schema pushed (${appliedStatements} statement(s) applied)`,
          );
        }
      } else if (subcommand === "pull") {
        const content = await introspectPostgres(pool);
        const outputPath = resolve(cwd, options.output ?? "schema.pulled.ts");
        await writeFile(outputPath, content, "utf-8");
        console.log(`Schema written to ${outputPath}`);
      } else {
        console.error("Usage: neoorm db push | pull");
        process.exit(1);
      }
    } finally {
      await pool.end();
    }
  });

program.parse();
