import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { orderedVisiblePages } from "../src/docs/nav.js";
import { hydratePageTitles, loadDocsPages } from "../src/docs/pages.js";
import { parseFrontmatter } from "../src/docs/text.js";

/** Regenerate llms-full.txt from docs/ (CI verifies the output is fresh). */
const SUMMARY =
	"NeoORM is a TypeScript-first SQL ORM: schema → codegen → typed client for PostgreSQL, SQLite, MySQL, and MariaDB. You own the SQL; it handles the boilerplate.";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pages = orderedVisiblePages(await loadDocsPages(join(rootDir, "docs")));
await hydratePageTitles(pages);

const parts: string[] = ["# NeoORM", "", `> ${SUMMARY}`, ""];
for (const page of pages) {
	const content = await readFile(page.sourcePath, "utf-8");
	const { body } = parseFrontmatter(content);
	const trimmed = body.replace(/^#\s+.+\n/, "").trim();
	parts.push(`## ${page.title}`, "", trimmed, "");
}

const output = `${parts.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
await writeFile(join(rootDir, "llms-full.txt"), output);
console.log(`wrote llms-full.txt (${pages.length} pages)`);
