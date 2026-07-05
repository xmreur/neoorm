#!/usr/bin/env node
import { Command } from "commander";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { generateFromSchema } from "../codegen/generate.js";
import { migrateDeploy, dbPush } from "../migrate/runner.js";
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
  .action(async () => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    const schemaPath = resolve(cwd, config.schema);
    const outDir = resolve(cwd, config.out);

    const { migrationName, schemaChanged, warnings } = await generateFromSchema(
      schemaPath,
      outDir,
    );

    console.log(`Generated client at ${outDir}/client.ts`);
    console.log(`Generated manifest at ${outDir}/manifest.ts`);
    if (migrationName) {
      console.log(`Created migration: ${migrationName}`);
    } else if (schemaChanged) {
      console.log("Manifest updated (no migration SQL needed)");
    } else {
      console.log("No schema changes detected");
    }
    for (const warning of warnings) {
      console.warn(`Warning: ${warning}`);
    }
  });

program
  .command("migrate")
  .description("Run migrations")
  .argument("[subcommand]", "dev | deploy")
  .action(async (subcommand) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    const outDir = resolve(cwd, config.out);
    const migrationsDir = join(outDir, "migrations");

    const pool = new Pool({ connectionString: config.datasource.url });

    try {
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
          const { generateFromSchema } = await import("../codegen/generate.js");
          const schemaPath = resolve(cwd, config.schema);
          const { migrationName, warnings } = await generateFromSchema(schemaPath, outDir);
          for (const warning of warnings) {
            console.warn(`Warning: ${warning}`);
          }
          if (migrationName) {
            await migrateDeploy(pool, join(outDir, "migrations"));
            console.log(`Created and applied: ${migrationName}`);
          }
        }
      } else {
        console.error("Usage: neoorm migrate dev | deploy");
        process.exit(1);
      }
    } finally {
      await pool.end();
    }
  });

program
  .command("db")
  .description("Database utilities")
  .argument("<subcommand>", "push | pull")
  .option("-o, --output <file>", "Output file for pull", "schema.pulled.ts")
  .action(async (subcommand, options: { output?: string }) => {
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
        await dbPush(pool, manifest);
        console.log("Database schema pushed");
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
