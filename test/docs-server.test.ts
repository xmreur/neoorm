import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/docs/markdown.js";
import { isDocsGroupId } from "../src/docs/nav.js";
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
	searchDocs,
	slugifyHeading,
} from "../src/docs/search.js";
import { createRequestHandler } from "../src/docs/server.js";
import { parseFrontmatter } from "../src/docs/text.js";

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
				description: "",
				group: "start",
				order: 10,
				keywords: "",
				hidden: false,
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
					record.slug === "schema-relations" &&
					record.heading === "Foreign keys",
			),
		).toBe(true);
	});

	it("ranks schema-relations for foreign key queries", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		await hydratePageTitles(pages);
		const index = await buildSearchIndex(pages);

		const hits = rankSearchResults("foreign key", index);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.slug).toBe("schema-relations");
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

	it("returns 400 for a malformed request URL instead of rejecting", async () => {
		const handler = createRequestHandler([], "0.0.0-test", []);
		const chunks: Buffer[] = [];
		const res = {
			statusCode: 0,
			headersSent: false,
			headers: {} as Record<string, string>,
			writeHead(status: number, headers: Record<string, string>) {
				this.statusCode = status;
				this.headersSent = true;
				Object.assign(this.headers, headers);
			},
			end(body?: string) {
				if (body !== undefined) chunks.push(Buffer.from(body));
			},
			destroy() {
				this.headersSent = true;
			},
		};
		await expect(
			handler(
				{ url: "//" } as IncomingMessage,
				res as unknown as ServerResponse,
			),
		).resolves.toBeUndefined();
		expect(res.statusCode).toBe(400);
		expect(Buffer.concat(chunks).toString("utf8")).toBe(
			"Invalid request URL",
		);
	});
});

describe("docs rendering", () => {
	it("adds heading ids, anchor links, and a table of contents", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		await hydratePageTitles(pages);
		const schemaRelations = pages.find(
			(page) => page.slug === "schema-relations",
		);
		expect(schemaRelations).toBeDefined();
		const html = await renderDocsPage(
			schemaRelations as NonNullable<typeof schemaRelations>,
			pages,
			"0.0.0-test",
		);
		expect(html).toContain('<h2 id="foreign-keys">');
		expect(html).toContain('href="#foreign-keys"');
		expect(html).toContain('class="toc-link depth-2"');
		expect(html).toContain("brand-lockup");
	});

	it("supports explicit heading anchors", async () => {
		const parsed = await renderMarkdown(
			"# Title\n\n## Custom heading {#custom-id}\n\nBody text.\n",
			{ highlightCode: false },
		);
		expect(parsed.html).toContain('<h2 id="custom-id">');
		expect(parsed.headings[0]?.id).toBe("custom-id");
		expect(parsed.headings[0]?.text).toBe("Custom heading");
	});

	it("switches package-manager commands across npm, yarn, pnpm, and bun", async () => {
		const parsed = await renderMarkdown(
			"```bash\nbun add neoorm pg\nbunx neoorm init\ncp .env.example .env\n```\n\nInstall with `bun add zod`.\n",
			{ highlightCode: false },
		);
		expect(parsed.html).toContain("npm install neoorm pg");
		expect(parsed.html).toContain("yarn add neoorm pg");
		expect(parsed.html).toContain("pnpm add neoorm pg");
		expect(parsed.html).toContain("npx neoorm init");
		expect(parsed.html).toContain("yarn dlx neoorm init");
		expect(parsed.html).toContain("pnpm dlx neoorm init");
		expect(parsed.html).toContain("cp .env.example .env");
		expect(parsed.html).toContain('class="pm-inline"');
		expect(parsed.html).toContain("npm install zod");
		expect(parsed.html).toContain('data-pm-choice="bun"');
	});

	it("renders GitHub-style callouts without the marker", async () => {
		const parsed = await renderMarkdown(
			"> [!WARNING]\n> Check the migration first.\n",
			{ highlightCode: false },
		);
		expect(parsed.html).toContain('class="callout callout-warning"');
		expect(parsed.html).toContain("Check the migration first.");
		expect(parsed.html).not.toContain("[!WARNING]");
	});

	it("highlights code blocks and adds copy controls", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		await hydratePageTitles(pages);
		const gettingStarted = pages.find(
			(page) => page.slug === "getting-started",
		);
		expect(gettingStarted).toBeDefined();
		const html = await renderDocsPage(
			gettingStarted as NonNullable<typeof gettingStarted>,
			pages,
			"0.0.0-test",
		);
		expect(html).toContain('class="code-block"');
		expect(html).toContain('class="shiki');
		expect(html).toContain("data-copy");
		expect(html).toContain('class="code-block-lang"');
	});

	it("serves css, js, favicon, and a styled 404", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		await hydratePageTitles(pages);
		const searchIndex = await buildSearchIndex(pages);
		const handler = createRequestHandler(pages, "0.0.0-test", searchIndex);

		const css = await request(handler, "/assets/docs.css");
		expect(css.statusCode).toBe(200);
		expect(css.headers["Content-Type"]).toContain("text/css");
		expect(css.body).toContain("--primary");
		expect(css.body).toContain("#8550FF");
		expect(css.body).toContain("#F4F3EF");
		expect(css.body).toContain("#111114");

		const js = await request(handler, "/assets/docs.js");
		expect(js.statusCode).toBe(200);
		expect(js.headers["Content-Type"]).toContain("text/javascript");

		const favicon = await request(handler, "/favicon.svg");
		expect(favicon.statusCode).toBe(200);
		expect(favicon.headers["Content-Type"]).toContain("image/svg+xml");
		expect(favicon.body).toContain("#8550FF");
		expect(favicon.body).toContain("#111114");

		const missing = await request(handler, "/docs/nope");
		expect(missing.statusCode).toBe(404);
		expect(missing.headers["Content-Type"]).toContain("text/html");
		expect(missing.body).toContain("Page not found");
	});
});

describe("docs search endpoint", () => {
	it("finds code identifiers such as findMany", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		await hydratePageTitles(pages);
		const index = await buildSearchIndex(pages);

		const hits = searchDocs("findMany", index);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.some((hit) => hit.slug === "queries")).toBe(true);
		const first = hits[0];
		expect(first).toBeDefined();
		expect(first?.excerpt.toLowerCase()).toContain("findmany");
		expect(first?.highlights.length).toBeGreaterThan(0);
	});

	it("serves ranked results from /search", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		await hydratePageTitles(pages);
		const searchIndex = await buildSearchIndex(pages);
		const handler = createRequestHandler(pages, "0.0.0-test", searchIndex);

		const response = await request(handler, "/search?q=foreign+key");
		expect(response.statusCode).toBe(200);
		expect(response.headers["Content-Type"]).toContain("application/json");
		const payload = JSON.parse(response.body) as {
			query: string;
			hits: { slug: string; highlights: unknown[] }[];
		};
		expect(payload.query).toBe("foreign key");
		expect(payload.hits.length).toBeGreaterThan(0);
		expect(payload.hits[0]?.slug).toBe("schema-relations");
		expect(payload.hits[0]?.highlights.length).toBeGreaterThan(0);
	});
});

describe("docs content integrity", () => {
	it("requires valid frontmatter and resolving internal links/anchors on every doc page", async () => {
		const docsDir = await resolveDocsDir();
		const pages = await loadDocsPages(docsDir);
		const anchorsBySlug = new Map<string, Set<string>>();
		const bodiesBySlug = new Map<string, string>();

		for (const page of pages) {
			const raw = await readFile(page.sourcePath, "utf-8");
			const { data, body } = parseFrontmatter(raw);
			expect(data.title, `${page.fileName} missing title`).toBeTruthy();
			expect(
				data.description,
				`${page.fileName} missing description`,
			).toBeTruthy();
			expect(
				data.group && isDocsGroupId(data.group),
				`${page.fileName} invalid group: ${data.group}`,
			).toBe(true);
			expect(
				Number.isFinite(Number(data.order)),
				`${page.fileName} invalid order: ${data.order}`,
			).toBe(true);

			const parsed = await renderMarkdown(body, { highlightCode: false });
			anchorsBySlug.set(
				page.slug,
				new Set(parsed.headings.map((heading) => heading.id)),
			);
			bodiesBySlug.set(page.slug, body);
		}

		const linkPattern = /\]\(([^)\s]+)\)/g;
		const broken: string[] = [];
		for (const page of pages) {
			const body = (bodiesBySlug.get(page.slug) ?? "")
				.replace(/```[\s\S]*?```/g, "")
				.replace(/`[^`]*`/g, "");
			for (const match of body.matchAll(linkPattern)) {
				const href = match[1];
				if (
					!href ||
					href.startsWith("http://") ||
					href.startsWith("https://") ||
					href.startsWith("mailto:")
				) {
					continue;
				}
				const [targetPath, hash] = href.split("#");
				const targetSlug = targetPath
					? targetPath.replace(/\.md$/, "")
					: page.slug;
				const anchors = anchorsBySlug.get(targetSlug);
				if (!anchors) {
					broken.push(`${page.fileName}: missing target ${href}`);
					continue;
				}
				if (hash && !anchors.has(hash)) {
					broken.push(
						`${page.fileName}: missing anchor #${hash} in ${targetSlug}.md`,
					);
				}
			}
		}

		expect(broken).toEqual([]);
	});
});

async function request(
	handler: ReturnType<typeof createRequestHandler>,
	url: string,
): Promise<{
	statusCode: number;
	headers: Record<string, string>;
	body: string;
}> {
	const chunks: Buffer[] = [];
	const res = {
		statusCode: 0,
		headers: {} as Record<string, string>,
		headersSent: false,
		writeHead(status: number, headers: Record<string, string>) {
			this.statusCode = status;
			this.headersSent = true;
			Object.assign(this.headers, headers);
		},
		end(body?: string) {
			if (body !== undefined) {
				chunks.push(Buffer.from(body));
			}
		},
		destroy() {
			this.headersSent = true;
		},
	};
	await handler({ url } as IncomingMessage, res as unknown as ServerResponse);
	return {
		statusCode: res.statusCode,
		headers: res.headers,
		body: Buffer.concat(chunks).toString("utf-8"),
	};
}
