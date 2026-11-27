import { readFile } from "node:fs/promises";
import { brandLockup, brandSymbol, FAVICON_SVG } from "./brand.js";
import { DOCS_JS } from "./client.js";
import { escapeAttribute, escapeHtml } from "./html.js";
import type { DocsHeading } from "./markdown.js";
import { highlightSnippet, renderMarkdown } from "./markdown.js";
import {
	DOC_GROUPS,
	type DocsGroupId,
	groupPages,
	orderedVisiblePages,
	visiblePages,
} from "./nav.js";
import { renderInstallCard } from "./package-manager.js";
import type { DocsPage } from "./pages.js";
import { DOCS_CSS } from "./styles.js";

const GITHUB_URL = "https://github.com/xmreur/neoorm";
const EDIT_BASE = "https://github.com/xmreur/neoorm/edit/main/docs";

const ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>`;
const ICON_MENU = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>`;
const ICON_SUN = `<svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"></path></svg>`;
const ICON_MOON = `<svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"></path></svg>`;
const ICON_GITHUB = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.3 9.3 0 0 1 12 6.96a9.3 9.3 0 0 1 2.5.35c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.25 10.25 0 0 0 22 12.23C22 6.58 17.52 2 12 2Z"></path></svg>`;
const ICON_ARROW_RIGHT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg>`;

const HERO_SNIPPETS = [
	{
		id: "schema",
		label: "schema.ts",
		lang: "typescript",
		code: `export const schema = defineSchema({
  users: table({
    id: id(),
    email: text().notNull().unique(),
  }),
  posts: table({
    id: id(),
    authorId: fk("users").notNull(),
    title: text().notNull(),
    published: bool().notNull().default(false),
  }),
});`,
	},
	{
		id: "query",
		label: "query.ts",
		lang: "typescript",
		code: `const posts = await db.posts.findMany({
  where: { published: true },
  with: { author: { select: { email: true } } },
  orderBy: { id: "desc" },
  take: 20,
});
// Post & { author: { email: string } }`,
	},
] as const;

const HERO_SQL_DIALECTS = [
	{
		id: "pg",
		label: "PostgreSQL",
		code: `-- PostgreSQL · $1, $2 placeholders
SELECT "posts".*, "author"."email" AS "author__email"
FROM "posts"
LEFT JOIN "users" AS "author"
  ON "author"."id" = "posts"."author_id"
WHERE "posts"."published" = $1
ORDER BY "posts"."id" DESC
LIMIT $2`,
	},
	{
		id: "sqlite",
		label: "SQLite",
		code: `-- SQLite · ? placeholders
SELECT "posts".*, "author"."email" AS "author__email"
FROM "posts"
LEFT JOIN "users" AS "author"
  ON "author"."id" = "posts"."author_id"
WHERE "posts"."published" = ?
ORDER BY "posts"."id" DESC
LIMIT ?`,
	},
	{
		id: "mysql",
		label: "MySQL 8",
		code: `-- MySQL 8 · backticks, ? placeholders
SELECT \`posts\`.*, \`author\`.\`email\` AS \`author__email\`
FROM \`posts\`
LEFT JOIN \`users\` AS \`author\`
  ON \`author\`.\`id\` = \`posts\`.\`author_id\`
WHERE \`posts\`.\`published\` = ?
ORDER BY \`posts\`.\`id\` DESC
LIMIT ?`,
	},
	{
		id: "mariadb",
		label: "MariaDB",
		code: `-- MariaDB 10.11 · backticks, ? placeholders
SELECT \`posts\`.*, \`author\`.\`email\` AS \`author__email\`
FROM \`posts\`
LEFT JOIN \`users\` AS \`author\`
  ON \`author\`.\`id\` = \`posts\`.\`author_id\`
WHERE \`posts\`.\`published\` = ?
ORDER BY \`posts\`.\`id\` DESC
LIMIT ?`,
	},
] as const;

const THEME_INIT_SCRIPT = `(function(){try{var key="neoorm-docs-theme";var stored=localStorage.getItem(key);var dark=window.matchMedia("(prefers-color-scheme: dark)").matches;var theme=stored==="light"||stored==="dark"?stored:(dark?"dark":"light");var root=document.documentElement;root.setAttribute("data-theme",theme);root.style.colorScheme=theme;var meta=document.querySelector('meta[name="theme-color"]');if(meta) meta.setAttribute("content",theme==="dark"?"#111114":"#F4F3EF");}catch(error){}})();`;

type ShellOptions = {
	title: string;
	description: string;
	version: string;
	pages: DocsPage[];
	mainHtml: string;
	activeSlug?: string;
	page?: DocsPage;
	headings?: DocsHeading[];
};

function groupLabel(group: DocsGroupId): string {
	return DOC_GROUPS.find((item) => item.id === group)?.label ?? "Docs";
}

function renderSidebar(
	pages: DocsPage[],
	version: string,
	activeSlug?: string,
): string {
	const groups = groupPages(pages)
		.map((group) => {
			const links = group.pages
				.map((page) => {
					const active = page.slug === activeSlug;
					return `<a class="nav-link${active ? " active" : ""}" href="/docs/${
						page.slug
					}"${active ? ' aria-current="page"' : ""}>${escapeHtml(
						page.title,
					)}</a>`;
				})
				.join("");
			return `<div class="nav-group"><span class="nav-group-label">${escapeHtml(
				group.label,
			)}</span>${links}</div>`;
		})
		.join("");

	return `<aside class="sidebar" id="sidebar" aria-label="Documentation navigation">
<div class="sidebar-mobile-head">
  <a class="brand" href="/" aria-label="NeoORM docs">${brandLockup()}${brandSymbol(
		"brand-logo-compact",
  )}</a>
  <button class="icon-button" type="button" data-nav-close aria-label="Close navigation">${ICON_CLOSE}</button>
</div>
<nav>${groups}</nav>
<div class="sidebar-footer">
  <a href="${GITHUB_URL}" target="_blank" rel="noreferrer">GitHub repository</a>
  <span class="version">NeoOrm v${escapeHtml(version)}</span>
</div>
</aside>`;
}

function renderToc(headings: DocsHeading[] | undefined): string {
	if (!headings || headings.length === 0) {
		return "";
	}
	const items = headings
		.map(
			(heading) =>
				`<li><a class="toc-link depth-${heading.depth}" href="#${escapeAttribute(
					heading.id,
				)}">${escapeHtml(heading.text)}</a></li>`,
		)
		.join("");
	return `<aside class="toc" aria-label="On this page"><p class="toc-label">On this page</p><nav><ul class="toc-list">${items}</ul></nav></aside>`;
}

function renderBreadcrumbs(page: DocsPage): string {
	return `<nav class="breadcrumbs" aria-label="Breadcrumb">
<a href="/">Docs</a><span class="sep">/</span><span>${escapeHtml(
		groupLabel(page.group),
	)}</span><span class="sep">/</span><span aria-current="page">${escapeHtml(
		page.title,
	)}</span>
</nav>`;
}

function renderPageNav(pages: DocsPage[], page: DocsPage): string {
	const ordered = orderedVisiblePages(pages);
	const index = ordered.findIndex((item) => item.slug === page.slug);
	if (index < 0) {
		return "";
	}
	const previous = index > 0 ? ordered[index - 1] : undefined;
	const next = index < ordered.length - 1 ? ordered[index + 1] : undefined;
	const links: string[] = [];
	if (previous) {
		links.push(
			`<a class="page-nav-link prev" href="/docs/${previous.slug}"><span class="page-nav-label">Previous</span><span class="page-nav-title">${escapeHtml(
				previous.title,
			)}</span></a>`,
		);
	} else {
		links.push("<span></span>");
	}
	if (next) {
		links.push(
			`<a class="page-nav-link next" href="/docs/${next.slug}"><span class="page-nav-label">Next</span><span class="page-nav-title">${escapeHtml(
				next.title,
			)}</span></a>`,
		);
	}
	return `<nav class="page-nav" aria-label="Page navigation">${links.join(
		"",
	)}</nav>`;
}

function renderPageFooter(page: DocsPage, version: string): string {
	return `<footer class="page-footer">
<a href="${EDIT_BASE}/${encodeURIComponent(
		page.fileName,
	)}" target="_blank" rel="noreferrer">Edit this page on GitHub</a>
<span>NeoOrm v${escapeHtml(version)}</span>
</footer>`;
}

function renderSearchDialog(): string {
	return `<div class="search-overlay" id="search-overlay" hidden>
  <div class="search-dialog" id="search-dialog" role="dialog" aria-modal="true" aria-label="Search documentation">
    <div class="search-input-row">
      ${ICON_SEARCH}
      <input class="search-input" id="search-input" type="search" placeholder="Search documentation…" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="search-results" aria-expanded="false" />
      <kbd class="search-esc">Esc</kbd>
      <button class="icon-button search-close" type="button" data-search-close aria-label="Close search">${ICON_CLOSE}</button>
    </div>
    <div class="search-body">
      <div class="search-hint" id="search-hint">Type to search the docs…</div>
      <div id="search-results" role="listbox" aria-label="Search results"></div>
    </div>
    <div class="search-footer">
      <span class="search-footer-keys"><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> open</span>
      <span>NeoOrm docs</span>
    </div>
  </div>
</div>`;
}

function docsScriptData(pages: DocsPage[], activeSlug?: string): string {
	const data = {
		slug: activeSlug ?? "",
		pages: orderedVisiblePages(pages).map((page) => ({
			slug: page.slug,
			title: page.title,
			description: page.description,
			group: groupLabel(page.group),
		})),
	};
	return JSON.stringify(data).replaceAll("<", "\\u003c");
}

function renderShell(options: ShellOptions): string {
	const {
		title,
		description,
		version,
		pages,
		mainHtml,
		activeSlug,
		page,
		headings,
	} = options;
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escapeAttribute(description)}" />
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#F4F3EF" />
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/assets/docs.css" />
  <script>${THEME_INIT_SCRIPT}</script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar">
    <button class="icon-button menu-button" type="button" data-nav-toggle aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar">${ICON_MENU}</button>
    <a class="brand" href="/" aria-label="NeoORM docs">${brandLockup()}${brandSymbol(
		"brand-logo-compact",
	)}<span class="brand-docs">Docs</span></a>
    <div class="topbar-spacer"></div>
    <button class="search-trigger" type="button" data-search-open aria-label="Search documentation">
      ${ICON_SEARCH}<span>Search docs</span><kbd>Ctrl K</kbd>
    </button>
    <a class="icon-button" href="${GITHUB_URL}" target="_blank" rel="noreferrer" aria-label="GitHub repository">${ICON_GITHUB}</a>
    <button class="icon-button" type="button" data-theme-toggle aria-label="Toggle theme">${ICON_SUN}${ICON_MOON}</button>
  </header>
  <div class="nav-backdrop" data-nav-backdrop></div>
  <div class="layout">
    ${renderSidebar(pages, version, activeSlug)}
    <main class="content" id="main">
      <div class="page">
        ${page ? renderBreadcrumbs(page) : ""}
        ${
			page
				? `<article class="markdown-body">${mainHtml}</article>`
				: `<div class="page-body">${mainHtml}</div>`
		}
        ${page ? `${renderPageNav(pages, page)}${renderPageFooter(page, version)}` : ""}
      </div>
    </main>
    ${renderToc(headings)}
  </div>
  ${renderSearchDialog()}
  <script>window.__NEOORM_DOCS__ = ${docsScriptData(
		pages,
		activeSlug,
  )};</script>
  <script src="/assets/docs.js" defer></script>
</body>
</html>`;
}

export async function renderDocsPage(
	page: DocsPage,
	nav: DocsPage[],
	version: string,
): Promise<string> {
	const markdown = await readFile(page.sourcePath, "utf-8");
	const parsed = await renderMarkdown(markdown, {
		pageSlugs: new Set(nav.map((item) => item.slug)),
	});
	const description =
		parsed.frontmatter.description ?? page.description ?? "";

	return renderShell({
		title: `${page.title} · NeoOrm`,
		description,
		version,
		pages: nav,
		mainHtml: parsed.html,
		activeSlug: page.slug,
		page,
		headings: parsed.headings,
	});
}

function landingCards(pages: DocsPage[], slugs: string[]): string {
	return slugs
		.map((slug) => pages.find((page) => page.slug === slug))
		.filter((page): page is DocsPage => Boolean(page))
		.map(
			(page) => `<a class="card" href="/docs/${page.slug}">
  <span class="card-title">${escapeHtml(page.title)}</span>
  <span class="card-description">${escapeHtml(page.description)}</span>
</a>`,
		)
		.join("");
}

function renderCardSection(
	label: string,
	detail: string,
	pages: DocsPage[],
	slugs: string[],
): string {
	return `<div class="section-heading"><h2>${escapeHtml(
		label,
	)}</h2><p>${escapeHtml(detail)}</p></div>
<div class="card-grid">${landingCards(pages, slugs)}</div>`;
}

async function renderHeroSpecimen(): Promise<string> {
	const [snippets, sqlDialects] = await Promise.all([
		Promise.all(
			HERO_SNIPPETS.map(async (snippet) => ({
				...snippet,
				html: await highlightSnippet(snippet.code, snippet.lang),
			})),
		),
		Promise.all(
			HERO_SQL_DIALECTS.map(async (dialect) => ({
				...dialect,
				html: await highlightSnippet(dialect.code, "sql"),
			})),
		),
	]);
	const topTabs = [
		...snippets.map((snippet, index) => ({
			id: snippet.id,
			label: snippet.label,
			selected: index === 0,
		})),
		{ id: "sql", label: "SQL", selected: false },
	];
	const tabs = topTabs
		.map(
			(tab) =>
				`<button type="button" class="specimen-tab" role="tab" data-hero-tab="${tab.id}" aria-selected="${
					tab.selected ? "true" : "false"
				}" tabindex="${tab.selected ? "0" : "-1"}">${escapeHtml(
					tab.label,
				)}</button>`,
		)
		.join("");
	const snippetPanels = snippets
		.map((snippet, index) => {
			const active = index === 0;
			return `<div class="specimen-panel" role="tabpanel" data-hero-panel="${snippet.id}" data-active="${
				active ? "true" : "false"
			}" aria-hidden="${active ? "false" : "true"}">${snippet.html}</div>`;
		})
		.join("");
	const sqlPanels = sqlDialects
		.map(
			(dialect) =>
				`<div class="specimen-panel" role="tabpanel" data-hero-panel="sql" data-hero-dialect-panel="${dialect.id}" data-active="false" aria-hidden="true">${dialect.html}</div>`,
		)
		.join("");
	const dialectButtons = sqlDialects
		.map(
			(dialect, index) =>
				`<button type="button" class="specimen-dialect" data-hero-dialect="${dialect.id}" aria-pressed="${
					index === 0 ? "true" : "false"
				}">${escapeHtml(dialect.label)}</button>`,
		)
		.join("");
	return `<div class="hero-specimen" data-hero-specimen data-active-tab="schema" data-active-dialect="pg">
  <div class="specimen-head">
    <div class="specimen-tabs" role="tablist" aria-label="NeoORM workflow">${tabs}</div>
    <button type="button" class="code-copy" data-copy-specimen>Copy</button>
  </div>
  <div class="specimen-body">${snippetPanels}${sqlPanels}</div>
  <div class="specimen-foot" role="group" aria-label="SQL dialect">${dialectButtons}</div>
</div>`;
}

export async function renderDocsIndex(
	nav: DocsPage[],
	version: string,
): Promise<string> {
	const pages = visiblePages(nav);
	const groups = groupPages(nav)
		.filter((group) => group.id !== "start" && group.id !== "contributing")
		.map((group) => {
			const count = group.pages.length;
			const countLabel = count === 1 ? "1 page" : `${count} pages`;
			return renderCardSection(
				group.label,
				countLabel,
				pages,
				group.pages.map((page) => page.slug),
			);
		})
		.join("");

	const install = renderInstallCard("bun add neoorm pg");
	const specimen = await renderHeroSpecimen();
	const main = `<section class="hero-grid">
  <div class="hero-copy">
    <h1 class="docs-lockup">${brandLockup()}<span class="sr-only">NeoORM</span></h1>
    <p class="hero-lead">TypeScript schema, generated typed client, and real SQL. You keep control of the query; the types keep up.</p>
    <div class="hero-actions">
      <a class="button primary" href="/docs/getting-started">Get started${ICON_ARROW_RIGHT}</a>
      <a class="button" href="${GITHUB_URL}" target="_blank" rel="noreferrer">${ICON_GITHUB}View on GitHub</a>
    </div>
    ${install ?? ""}
  </div>
  ${specimen}
</section>
${renderCardSection(
	"Start here",
	"Install, configure, and browse data",
	pages,
	["getting-started", "configuration", "studio"],
)}
${groups}`;

	return renderShell({
		title: "NeoOrm documentation",
		description:
			"Documentation for NeoOrm, a TypeScript-first SQL ORM for PostgreSQL, SQLite, MySQL, and MariaDB.",
		version,
		pages: nav,
		mainHtml: main,
	});
}

export function renderNotFound(
	nav: DocsPage[],
	version: string,
	pathname: string,
): string {
	const main = `<section class="not-found">
  <div class="not-found-code">404</div>
  <h1>Page not found</h1>
  <p>There is no page at <code>${escapeHtml(
		pathname,
  )}</code>. Try the search, or start from the documentation index.</p>
  <div class="hero-actions" style="justify-content:center">
    <button class="button primary" type="button" data-search-open>Search the docs</button>
    <a class="button" href="/">Documentation home</a>
  </div>
</section>`;

	return renderShell({
		title: "Page not found · NeoOrm",
		description:
			"The requested NeoOrm documentation page could not be found.",
		version,
		pages: nav,
		mainHtml: main,
	});
}

export function docsAssets(): {
	css: string;
	js: string;
	favicon: string;
} {
	return {
		css: DOCS_CSS,
		js: DOCS_JS,
		favicon: FAVICON_SVG,
	};
}
