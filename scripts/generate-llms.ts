import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hydratePageTitles, loadDocsPages } from "../src/docs/pages.js";

/** Regenerate llms-full.txt from docs/ (CI verifies the output is fresh). */
const SUMMARY =
	"NeoOrm is a TypeScript-first SQL ORM: schema → codegen → typed client for PostgreSQL, SQLite, MySQL, and MariaDB. You own the SQL; it handles the boilerplate.";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pages = await loadDocsPages(join(rootDir, "docs"));
await hydratePageTitles(pages);

const parts: string[] = ["# NeoOrm", "", `> ${SUMMARY}`, ""];
for (const page of pages) {
	const content = await readFile(page.sourcePath, "utf-8");
	const body = content.replace(/^#\s+.+\n/, "").trim();
	parts.push(`## ${page.title}`, "", body, "");
}

const output = `${parts.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
await writeFile(join(rootDir, "llms-full.txt"), output);
console.log(`wrote llms-full.txt (${pages.length} pages)`);
