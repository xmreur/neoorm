import { access, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { generateFromSchema } from "../codegen/generate.js";
import type { GenerateSummary } from "../codegen/generate-summary.js";
import {
  envExampleTemplate,
  neoormConfigTemplate,
  schemaTemplate,
} from "./templates.js";

export type InitOptions = {
  cwd?: string;
  schemaPath?: string;
  outDir?: string;
  force?: boolean;
};

export type InitResult = {
  written: string[];
  skipped: string[];
  migrationName: string | null;
  outDir: string;
  schemaPath: string;
  summary: GenerateSummary;
  warnings: string[];
};

const CONFIG_FILE = "neoorm.config.ts";
const ENV_EXAMPLE_FILE = ".env.example";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function toDisplayPath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  return rel.startsWith("..") ? absolutePath : rel || ".";
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const schemaRel = options.schemaPath ?? "./schema.ts";
  const outRel = options.outDir ?? "./neoorm";
  const schemaPath = resolve(cwd, schemaRel);
  const outDir = resolve(cwd, outRel);
  const configPath = join(cwd, CONFIG_FILE);
  const envExamplePath = join(cwd, ENV_EXAMPLE_FILE);

  const scaffoldTargets = [
    { path: configPath, label: CONFIG_FILE },
    { path: schemaPath, label: toDisplayPath(cwd, schemaPath) },
    { path: envExamplePath, label: ENV_EXAMPLE_FILE },
  ];

  const existing: string[] = [];
  for (const target of scaffoldTargets) {
    if (await fileExists(target.path)) {
      existing.push(target.label);
    }
  }

  if (existing.length > 0 && !options.force) {
    throw new Error(
      `Scaffold files already exist: ${existing.join(", ")}. Re-run with --force to overwrite.`,
    );
  }

  const written: string[] = [];
  const skipped: string[] = [];

  const filesToWrite: Array<{ path: string; label: string; content: string }> = [
    {
      path: configPath,
      label: CONFIG_FILE,
      content: neoormConfigTemplate(schemaRel, outRel),
    },
    {
      path: schemaPath,
      label: toDisplayPath(cwd, schemaPath),
      content: schemaTemplate(),
    },
    {
      path: envExamplePath,
      label: ENV_EXAMPLE_FILE,
      content: envExampleTemplate(),
    },
  ];

  for (const file of filesToWrite) {
    if (!options.force && (await fileExists(file.path))) {
      skipped.push(file.label);
      continue;
    }
    await writeFile(file.path, file.content, "utf-8");
    written.push(file.label);
  }

  const { migrationName, summary, warnings } = await generateFromSchema(schemaPath, outDir);

  return {
    written,
    skipped,
    migrationName,
    outDir,
    schemaPath,
    summary,
    warnings,
  };
}

export function formatInitNextSteps(
  cwd: string,
  schemaPath: string,
  outDir: string,
): string[] {
  const schemaImport = toDisplayPath(cwd, resolve(schemaPath));
  const clientImport = `${outDir.replace(/^\.\//, "")}/client.js`;
  return [
    "Next steps:",
    "  1. cp .env.example .env  # set DATABASE_URL",
    "  2. neoorm migrate deploy",
    `  3. import { db } from "./${clientImport}"`,
    `     # schema: ${schemaImport}`,
  ];
}
