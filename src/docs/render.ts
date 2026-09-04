import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { marked } from "marked";
import type { DocsPage } from "./pages.js";

function rewriteMarkdownLinks(html: string): string {
	return html.replace(
		/href="([^"]+\.md)(#[^"]*)?"/g,
		(_match, href: string, hash = "") => {
			const fileName = basename(href);
			const slug = fileName.replace(/\.md$/, "");
			return `href="/docs/${slug}${hash}"`;
		},
	);
}

export async function renderDocsPage(
	page: DocsPage,
	nav: DocsPage[],
	version: string,
): Promise<string> {
	const markdown = await readFile(page.sourcePath, "utf-8");
	const body = rewriteMarkdownLinks(
		await marked.parse(markdown, {
			gfm: true,
			breaks: false,
		}),
	);

	const navItems = nav
		.map((item) => {
			const active = item.slug === page.slug ? " active" : "";
			return `<a class="nav-link${active}" href="/docs/${item.slug}">${escapeHtml(item.title)}</a>`;
		})
		.join("\n");

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(page.title)} · NeoOrm</title>
  <style>${DOCS_CSS}</style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <a href="/">NeoOrm</a>
        <span class="version">v${escapeHtml(version)}</span>
      </div>
      <nav class="nav">${navItems}</nav>
    </aside>
    <main class="content">
      <article class="markdown-body">${body}</article>
    </main>
  </div>
</body>
</html>`;
}

export function renderDocsIndex(
	nav: DocsPage[],
	version: string,
): string {
	const cards = nav
		.map(
			(page) => `<a class="card" href="/docs/${page.slug}">
  <h2>${escapeHtml(page.title)}</h2>
  <p>${escapeHtml(page.slug)}.md</p>
</a>`,
		)
		.join("\n");

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NeoOrm Documentation</title>
  <style>${DOCS_CSS}</style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <a href="/">NeoOrm</a>
        <span class="version">v${escapeHtml(version)}</span>
      </div>
      <nav class="nav">${nav
				.map(
					(item) =>
						`<a class="nav-link" href="/docs/${item.slug}">${escapeHtml(item.title)}</a>`,
				)
				.join("\n")}</nav>
    </aside>
    <main class="content">
      <section class="hero">
        <h1>NeoOrm documentation</h1>
        <p>TypeScript-first PostgreSQL and SQLite ORM with schema DSL, codegen, and typed relations.</p>
      </section>
      <section class="cards">${cards}</section>
    </main>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

const DOCS_CSS = `
:root {
  color-scheme: light dark;
  --bg: #0b1020;
  --panel: #121933;
  --text: #e8edf8;
  --muted: #9aa7c3;
  --accent: #6ea8ff;
  --border: #24304d;
  --code-bg: #0d1428;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f7f8fc;
    --panel: #ffffff;
    --text: #172033;
    --muted: #5b677f;
    --accent: #245bdb;
    --border: #d8deea;
    --code-bg: #eef2f8;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  min-height: 100vh;
}
.sidebar {
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 1.25rem;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: auto;
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 1rem;
  font-weight: 700;
  font-size: 1.1rem;
}
.version {
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 500;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.nav-link {
  display: block;
  padding: 0.45rem 0.65rem;
  border-radius: 0.5rem;
  color: var(--text);
}
.nav-link.active,
.nav-link:hover {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  text-decoration: none;
}
.content {
  padding: 2rem clamp(1rem, 4vw, 3rem) 4rem;
  max-width: 920px;
}
.hero h1 { margin-top: 0; font-size: 2rem; }
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
  margin-top: 1.5rem;
}
.card {
  display: block;
  padding: 1rem 1.1rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--panel);
  color: inherit;
}
.card:hover { text-decoration: none; border-color: var(--accent); }
.card h2 { margin: 0 0 0.35rem; font-size: 1rem; }
.card p { margin: 0; color: var(--muted); font-size: 0.9rem; }
.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4 {
  line-height: 1.25;
  scroll-margin-top: 1rem;
}
.markdown-body h1 { font-size: 2rem; margin-top: 0; }
.markdown-body h2 {
  margin-top: 2rem;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid var(--border);
}
.markdown-body pre {
  overflow: auto;
  padding: 1rem;
  border-radius: 0.75rem;
  background: var(--code-bg);
  border: 1px solid var(--border);
}
.markdown-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.markdown-body :not(pre) > code {
  padding: 0.15rem 0.35rem;
  border-radius: 0.35rem;
  background: var(--code-bg);
}
.markdown-body table {
  width: 100%;
  border-collapse: collapse;
  display: block;
  overflow: auto;
}
.markdown-body th,
.markdown-body td {
  border: 1px solid var(--border);
  padding: 0.5rem 0.75rem;
  text-align: left;
}
.markdown-body blockquote {
  margin: 1rem 0;
  padding: 0.25rem 1rem;
  border-left: 3px solid var(--accent);
  color: var(--muted);
}
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar {
    position: static;
    height: auto;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
}
`;
