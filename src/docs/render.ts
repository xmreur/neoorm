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

function renderNavItems(nav: DocsPage[], activeSlug?: string): string {
	return nav
		.map((item) => {
			const active = item.slug === activeSlug ? " active" : "";
			return `<a class="nav-link${active}" href="/docs/${item.slug}">${escapeHtml(item.title)}</a>`;
		})
		.join("\n");
}

function renderSidebar(nav: DocsPage[], version: string, activeSlug?: string): string {
	return `<aside class="sidebar">
      <div class="brand">
        <a href="/">NeoOrm</a>
        <span class="version">v${escapeHtml(version)}</span>
      </div>
      <div class="search">
        <input
          type="search"
          id="docs-search"
          placeholder="Search docs…"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search documentation"
          aria-controls="docs-search-results"
          aria-expanded="false"
        />
        <div id="docs-search-results" class="search-results" hidden></div>
      </div>
      <nav class="nav">${renderNavItems(nav, activeSlug)}</nav>
    </aside>`;
}

function renderDocsShell(
	title: string,
	version: string,
	nav: DocsPage[],
	mainHtml: string,
	activeSlug?: string,
): string {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${DOCS_CSS}</style>
</head>
<body>
  <div class="layout">
    ${renderSidebar(nav, version, activeSlug)}
    <main class="content">
      ${mainHtml}
    </main>
  </div>
  <script>${DOCS_SEARCH_SCRIPT}</script>
</body>
</html>`;
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

	return renderDocsShell(
		`${page.title} · NeoOrm`,
		version,
		nav,
		`<article class="markdown-body">${body}</article>`,
		page.slug,
	);
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

	return renderDocsShell(
		"NeoOrm Documentation",
		version,
		nav,
		`<section class="hero">
        <h1>NeoOrm documentation</h1>
        <p>TypeScript-first PostgreSQL and SQLite ORM with schema DSL, codegen, and typed relations.</p>
      </section>
      <section class="cards">${cards}</section>`,
	);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

const DOCS_SEARCH_SCRIPT = `
(() => {
  const input = document.getElementById("docs-search");
  const resultsEl = document.getElementById("docs-search-results");
  if (!input || !resultsEl) return;

  let index = null;
  let indexPromise = null;
  let debounceTimer = null;
  let activeIndex = -1;
  let currentHits = [];

  function escapeHtml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function tokenize(query) {
    return query.toLowerCase().split(/\\s+/).map((t) => t.trim()).filter(Boolean);
  }

  function scoreRecord(record, tokens) {
    const title = record.title.toLowerCase();
    const heading = (record.heading || "").toLowerCase();
    const text = record.text.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (title === token) score += 10;
      else if (title.startsWith(token)) score += 8;
      else if (title.includes(token)) score += 5;
      if (heading === token) score += 6;
      else if (heading.startsWith(token)) score += 5;
      else if (heading.includes(token)) score += 4;
      if (text.includes(token)) {
        score += 3;
        const occurrences = text.split(token).length - 1;
        if (occurrences > 1) score += Math.min(occurrences - 1, 3);
      }
    }
    return score;
  }

  function rankResults(query, records) {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const hits = [];
    for (const record of records) {
      const score = scoreRecord(record, tokens);
      if (score > 0) hits.push({ ...record, score });
    }
    hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return hits.slice(0, 8);
  }

  function highlightExcerpt(excerpt, query) {
    const tokens = tokenize(query).filter((t) => t.length >= 2);
    let html = escapeHtml(excerpt);
    for (const token of tokens) {
      const re = new RegExp("(" + token.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&") + ")", "gi");
      html = html.replace(re, "<mark>$1</mark>");
    }
    return html;
  }

  function resultHref(hit) {
    return hit.anchor ? "/docs/" + hit.slug + "#" + hit.anchor : "/docs/" + hit.slug;
  }

  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (!indexPromise) {
      indexPromise = fetch("/search-index.json")
        .then((res) => {
          if (!res.ok) throw new Error("Failed to load search index");
          return res.json();
        })
        .then((data) => {
          index = data;
          return index;
        });
    }
    return indexPromise;
  }

  function closeResults() {
    resultsEl.hidden = true;
    input.setAttribute("aria-expanded", "false");
    activeIndex = -1;
    currentHits = [];
  }

  function renderResults(hits, query) {
    if (hits.length === 0) {
      resultsEl.innerHTML = '<div class="search-empty">No results</div>';
      resultsEl.hidden = false;
      input.setAttribute("aria-expanded", "true");
      return;
    }

    resultsEl.innerHTML = hits
      .map((hit, i) => {
        const heading = hit.heading
          ? '<span class="search-result-heading">' + escapeHtml(hit.heading) + "</span>"
          : "";
        return (
          '<a class="search-result' +
          (i === activeIndex ? " active" : "") +
          '" href="' +
          escapeHtml(resultHref(hit)) +
          '">' +
          '<span class="search-result-title">' +
          escapeHtml(hit.title) +
          "</span>" +
          heading +
          '<span class="search-result-excerpt">' +
          highlightExcerpt(hit.excerpt, query) +
          "</span>" +
          "</a>"
        );
      })
      .join("");
    resultsEl.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function updateActiveResult() {
    const items = resultsEl.querySelectorAll(".search-result");
    items.forEach((item, i) => {
      item.classList.toggle("active", i === activeIndex);
    });
    const active = items[activeIndex];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  async function runSearch() {
    const query = input.value.trim();
    if (!query) {
      closeResults();
      return;
    }
    const records = await loadIndex();
    currentHits = rankResults(query, records);
    activeIndex = currentHits.length > 0 ? 0 : -1;
    renderResults(currentHits, query);
  }

  input.addEventListener("focus", () => {
    void loadIndex();
  });

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void runSearch();
    }, 150);
  });

  input.addEventListener("keydown", (event) => {
    if (resultsEl.hidden) return;
    if (event.key === "Escape") {
      closeResults();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (currentHits.length === 0) return;
      activeIndex = Math.min(activeIndex + 1, currentHits.length - 1);
      updateActiveResult();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (currentHits.length === 0) return;
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActiveResult();
      return;
    }
    if (event.key === "Enter" && activeIndex >= 0) {
      const hit = currentHits[activeIndex];
      if (hit) {
        event.preventDefault();
        window.location.href = resultHref(hit);
      }
    }
  });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Node)) return;
    if (!input.contains(event.target) && !resultsEl.contains(event.target)) {
      closeResults();
    }
  });
})();
`;

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
.search {
  position: relative;
  margin-bottom: 1rem;
}
.search input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
}
.search input:focus {
  outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
  outline-offset: 1px;
}
.search-results {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 0.35rem);
  z-index: 20;
  max-height: 18rem;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--panel);
  box-shadow: 0 10px 30px color-mix(in srgb, var(--bg) 35%, transparent);
}
.search-result {
  display: block;
  padding: 0.65rem 0.75rem;
  color: inherit;
  border-bottom: 1px solid var(--border);
}
.search-result:last-child {
  border-bottom: 0;
}
.search-result:hover,
.search-result.active {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  text-decoration: none;
}
.search-result-title {
  display: block;
  font-weight: 600;
  font-size: 0.92rem;
}
.search-result-heading {
  display: block;
  color: var(--muted);
  font-size: 0.82rem;
  margin-top: 0.1rem;
}
.search-result-excerpt {
  display: block;
  color: var(--muted);
  font-size: 0.8rem;
  margin-top: 0.25rem;
  line-height: 1.4;
}
.search-result-excerpt mark {
  background: color-mix(in srgb, var(--accent) 25%, transparent);
  color: inherit;
  padding: 0 0.1rem;
  border-radius: 0.15rem;
}
.search-empty {
  padding: 0.75rem;
  color: var(--muted);
  font-size: 0.9rem;
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
  .search-results {
    position: static;
    max-height: 12rem;
    margin-top: 0.35rem;
  }
}
`;
