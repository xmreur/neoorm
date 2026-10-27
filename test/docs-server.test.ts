import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hydratePageTitles, loadDocsPages } from "../src/docs/pages.js";
import { renderDocsPage } from "../src/docs/render.js";
import {
	resolveDocsDir,
	resolveDocsDirFrom,
} from "../src/docs/resolve-docs-dir.js";
import {
	buildSearchIndex,
	plainTextFromMarkdown,
	rankSearchResults,
	slugifyHeading,
} from "../src/docs/search.js";
import { createRequestHandler } from "../src/docs/server.js";

describe("docs server", () => {
	it("finds the bundled docs directory", async () => {
		const docsDir = await resolveDocsDir();
		expect(docsDir.endsWith("/docs")).toBe(true);
	});

	it("ignores a project docs directory and requires the packaged marker", async () => {
		const root = await mkdtemp(join(tmpdir(), "neoorm-docs-"));
		const projectDocs = join(root, "project", "docs");
		await mkdir(projectDocs, { recursive: true });
		await writeFile(
			join(projectDocs, "readme.md"),
			"# Project\n\n<script>alert(1)</script>\n",
		);
		const moduleDir = join(root, "pkg", "dist", "docs");
		await mkdir(moduleDir, { recursive: true });
		await expect(resolveDocsDirFrom(moduleDir)).rejects.toThrow(
			/Could not find NeoOrm documentation/,
		);

		const packaged = join(root, "pkg", "docs");
		await mkdir(packaged, { recursive: true });
		await writeFile(join(packaged, "getting-started.md"), "# Start\n");
		await expect(resolveDocsDirFrom(moduleDir)).resolves.toBe(packaged);
	});

	it("escapes raw HTML in markdown pages", async () => {
		const dir = await mkdtemp(join(tmpdir(), "neoorm-docs-page-"));
		const sourcePath = join(dir, "xss.md");
		await writeFile(
			sourcePath,
			"# Hello\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n",
		);
		const html = await renderDocsPage(
			{
				slug: "xss",
				title: "Hello",
				fileName: "xss.md",
				sourcePath,
			},
			[],
			"test",
		);
		expect(html).not.toContain("<script>alert");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	it("loads markdown pages in a stable order", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		await hydratePageTitles(pages);

		expect(pages.length).toBeGreaterThan(0);
		expect(pages[0]?.slug).toBe("getting-started");
		expect(pages[1]?.slug).toBe("examples");
		expect(pages.some((page) => page.slug === "schema")).toBe(true);
		expect(pages.some((page) => page.slug === "studio")).toBe(true);
		expect(pages[0]?.title.length).toBeGreaterThan(0);
		expect(pages[0]?.sourcePath).toBe(
			join(docsDir, `${pages[0]?.slug}.md`),
		);
	});
});

describe("docs search", () => {
	it("strips fenced code blocks from plain text", () => {
		const text = plainTextFromMarkdown(`
# Title

Intro paragraph.

\`\`\`ts
const secret = "hidden";
\`\`\`

More text.
`);
		expect(text).not.toContain("secret");
		expect(text).toContain("Intro paragraph");
		expect(text).toContain("More text");
	});

	it("slugifies headings for anchors", () => {
		expect(slugifyHeading("Foreign keys")).toBe("foreign-keys");
		expect(slugifyHeading("`neoorm docs`")).toBe("neoorm-docs");
	});

	it("builds search records for bundled docs", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		await hydratePageTitles(pages);
		const index = await buildSearchIndex(pages);

		expect(index.length).toBeGreaterThan(pages.length);
		expect(index.some((record) => record.slug === "schema")).toBe(true);
		expect(
			index.some(
				(record) =>
					record.slug === "schema" &&
					record.heading === "Foreign keys",
			),
		).toBe(true);
	});

	it("ranks schema for foreign key queries", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		await hydratePageTitles(pages);
		const index = await buildSearchIndex(pages);

		const hits = rankSearchResults("foreign key", index);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.slug).toBe("schema");
	});

	it("ranks migrations page for migration queries", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		await hydratePageTitles(pages);
		const index = await buildSearchIndex(pages);

		const hits = rankSearchResults("migrations", index);
		expect(hits.some((hit) => hit.slug === "migrations")).toBe(true);
	});

	it("serves search index JSON", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		await hydratePageTitles(pages);
		const searchIndex = await buildSearchIndex(pages);
		const handler = createRequestHandler(pages, "0.0.0-test", searchIndex);

		const chunks: Buffer[] = [];
		const res = {
			statusCode: 0,
			headers: {} as Record<string, string>,
			writeHead(status: number, headers: Record<string, string>) {
				this.statusCode = status;
				Object.assign(this.headers, headers);
			},
			end(body: string) {
				chunks.push(Buffer.from(body));
			},
		};

		await handler(
			{
				url: "/search-index.json",
			} as import("node:http").IncomingMessage,
			res as unknown as import("node:http").ServerResponse,
		);

		expect(res.statusCode).toBe(200);
		expect(res.headers["Content-Type"]).toContain("application/json");
		const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
		expect(Array.isArray(payload)).toBe(true);
		expect(payload.length).toBeGreaterThan(0);
	});
});
