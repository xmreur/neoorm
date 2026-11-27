import {
	lexer,
	parser,
	Renderer,
	type Token,
	type Tokens,
	walkTokens,
} from "marked";
import { createHighlighter, type Highlighter } from "shiki";
import { escapeAttribute, escapeHtml, safeHref } from "./html.js";
import {
	renderPackageManagerBlock,
	renderPackageManagerInline,
} from "./package-manager.js";
import { createSlugger, slugifyHeading } from "./slug.js";
import {
	extractCodeIdentifiers,
	firstParagraph,
	parseFrontmatter,
	plainHeadingText,
	plainTextFromMarkdown,
} from "./text.js";

export type DocsHeading = {
	id: string;
	text: string;
	depth: number;
};

export type DocsSection = {
	heading?: DocsHeading;
	anchor?: string;
	text: string;
	code: string;
	excerpt: string;
};

export type ParsedDoc = {
	frontmatter: Record<string, string>;
	body: string;
	html: string;
	headings: DocsHeading[];
	sections: DocsSection[];
};

export type RenderMarkdownOptions = {
	pageSlugs?: Set<string>;
	highlightCode?: boolean;
};

const ANCHOR_MARKER = "__NEOORM_ANCHOR_";
const ANCHOR_PATTERN = /^(#{1,6}\s+.*?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/gm;
const MARKER_PATTERN = /\s*__NEOORM_ANCHOR_([a-z0-9][a-z0-9-]*)__\s*$/;

const SHIKI_LANGS = [
	"typescript",
	"javascript",
	"bash",
	"json",
	"sql",
	"diff",
	"yaml",
	"ini",
	"html",
	"css",
] as const;

const LANG_ALIASES: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	yml: "yaml",
	toml: "ini",
	text: "text",
	plaintext: "text",
	"": "text",
};

const LANG_LABELS: Record<string, string> = {
	typescript: "TypeScript",
	javascript: "JavaScript",
	bash: "Shell",
	json: "JSON",
	sql: "SQL",
	diff: "Diff",
	yaml: "YAML",
	ini: "INI",
	html: "HTML",
	css: "CSS",
	text: "Text",
};

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
	highlighterPromise ??= createHighlighter({
		themes: ["github-light", "github-dark"],
		langs: [...SHIKI_LANGS],
	});
	return highlighterPromise;
}

function normalizeLang(lang: string | undefined): string {
	const first = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	return LANG_ALIASES[first] ?? first;
}

function codeLabel(lang: string | undefined): string {
	const normalized = normalizeLang(lang);
	return LANG_LABELS[normalized] ?? (normalized || "Text");
}

async function highlightCode(
	code: string,
	lang: string | undefined,
	enabled: boolean,
): Promise<string> {
	const normalized = normalizeLang(lang);
	if (!enabled || normalized === "text") {
		return `<pre class="shiki shiki-fallback"><code>${escapeHtml(code)}</code></pre>`;
	}
	try {
		const highlighter = await getHighlighter();
		return highlighter.codeToHtml(code, {
			lang: normalized,
			themes: { light: "github-light", dark: "github-dark" },
			defaultColor: false,
		});
	} catch {
		return `<pre class="shiki shiki-fallback"><code>${escapeHtml(code)}</code></pre>`;
	}
}

export async function highlightSnippet(
	code: string,
	lang: string,
): Promise<string> {
	return highlightCode(code, lang, true);
}

function wrapCodeBlock(html: string, lang: string | undefined): string {
	return `<div class="code-block" data-lang="${escapeAttribute(
		normalizeLang(lang) || "text",
	)}">
<div class="code-block-header"><span class="code-block-lang">${escapeHtml(
		codeLabel(lang),
	)}</span><button type="button" class="code-copy" data-copy>Copy</button></div>
${html}
</div>`;
}

function prepareExplicitAnchors(markdown: string): string {
	return markdown.replace(
		ANCHOR_PATTERN,
		(_match, heading: string, id: string) =>
			`${heading} ${ANCHOR_MARKER}${id}__`,
	);
}

function headingMarker(text: string): {
	explicitId?: string;
	cleanText: string;
} {
	const match = text.match(MARKER_PATTERN);
	if (!match) {
		return { cleanText: text };
	}
	const explicitId = match[1];
	const cleanText = text.slice(0, match.index).trim();
	return explicitId ? { explicitId, cleanText } : { cleanText };
}

function rewriteHref(href: string, pageSlugs: Set<string>): string {
	const [rawPath, hash] = href.split("#");
	const pathPart = rawPath ?? "";
	if (pathPart.endsWith(".md")) {
		const slug = pathPart.split("/").pop()?.replace(/\.md$/, "");
		if (slug && pageSlugs.has(slug)) {
			return `/docs/${slug}${hash ? `#${hash}` : ""}`;
		}
	}
	return href;
}

class DocsRenderer extends Renderer {
	private readonly headingIds: WeakMap<object, string>;
	private readonly codeHtml: WeakMap<object, string>;
	private readonly pageSlugs: Set<string>;

	constructor(
		headingIds: WeakMap<object, string>,
		codeHtml: WeakMap<object, string>,
		pageSlugs: Set<string>,
	) {
		super();
		this.headingIds = headingIds;
		this.codeHtml = codeHtml;
		this.pageSlugs = pageSlugs;
	}

	html(token: Tokens.HTML | Tokens.Tag): string {
		return escapeHtml(token.text);
	}

	heading(token: Tokens.Heading): string {
		const id = this.headingIds.get(token) ?? slugifyHeading(token.text);
		const marker = headingMarker(token.text);
		let inner = this.parser.parseInline(token.tokens);
		if (marker.explicitId) {
			inner = inner.replace(MARKER_PATTERN, "");
		}
		const anchor =
			token.depth >= 2
				? `<a class="heading-anchor" href="#${escapeAttribute(
						id,
					)}" aria-label="Link to ${escapeAttribute(
						marker.cleanText,
					)}">#</a>`
				: "";
		return `<h${token.depth} id="${escapeAttribute(
			id,
		)}">${inner}${anchor}</h${token.depth}>\n`;
	}

	code(token: Tokens.Code): string {
		return (
			this.codeHtml.get(token) ??
			renderPackageManagerBlock(token.text) ??
			wrapCodeBlock(
				`<pre class="shiki shiki-fallback"><code>${escapeHtml(
					token.text,
				)}</code></pre>`,
				token.lang,
			)
		);
	}

	codespan(token: Tokens.Codespan): string {
		return (
			renderPackageManagerInline(token.text) ??
			`<code>${escapeHtml(token.text)}</code>`
		);
	}

	link(token: Tokens.Link): string {
		const href = safeHref(rewriteHref(token.href, this.pageSlugs));
		const inner = this.parser.parseInline(token.tokens);
		if (!href) {
			return inner;
		}
		const external = /^https?:\/\//.test(href);
		const title = token.title
			? ` title="${escapeAttribute(token.title)}"`
			: "";
		return `<a href="${escapeAttribute(href)}"${title}${
			external ? ' target="_blank" rel="noreferrer noopener"' : ""
		}>${inner}</a>`;
	}

	image(token: Tokens.Image): string {
		const href = safeHref(token.href);
		if (!href) {
			return escapeHtml(token.text);
		}
		const title = token.title
			? ` title="${escapeAttribute(token.title)}"`
			: "";
		return `<img src="${escapeAttribute(
			href,
		)}" alt="${escapeAttribute(token.text)}"${title} loading="lazy" />`;
	}

	table(token: Tokens.Table): string {
		return `<div class="table-wrap">${super.table(token)}</div>`;
	}

	blockquote(token: Tokens.Blockquote): string {
		const kind = consumeAlert(token);
		const inner = this.parser.parse(token.tokens);
		if (!kind) {
			return `<blockquote>\n${inner}</blockquote>\n`;
		}
		const title = kind.charAt(0).toUpperCase() + kind.slice(1);
		return `<div class="callout callout-${kind}"><p class="callout-title">${title}</p>\n${inner}</div>\n`;
	}
}

const ALERT_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+|$)/;

function alertKind(
	label: string,
): "note" | "tip" | "important" | "warning" | "caution" | undefined {
	switch (label) {
		case "NOTE":
			return "note";
		case "TIP":
			return "tip";
		case "IMPORTANT":
			return "important";
		case "WARNING":
			return "warning";
		case "CAUTION":
			return "caution";
		default:
			return undefined;
	}
}

function consumeAlert(
	token: Tokens.Blockquote,
): "note" | "tip" | "important" | "warning" | "caution" | undefined {
	const first = token.tokens[0];
	if (first?.type !== "paragraph") {
		return undefined;
	}
	const match = first.text.match(ALERT_PATTERN);
	const label = match?.[1];
	const kind = label ? alertKind(label) : undefined;
	if (!kind || !match) {
		return undefined;
	}
	const marker = match[0];
	first.text = first.text.slice(marker.length);
	first.raw = first.raw.replace(marker, "");
	const inline = first.tokens?.[0];
	if (inline && "text" in inline && typeof inline.text === "string") {
		inline.text = inline.text.replace(ALERT_PATTERN, "");
	}
	if (inline && "raw" in inline && typeof inline.raw === "string") {
		inline.raw = inline.raw.replace(ALERT_PATTERN, "");
	}
	if (first.text.trim() === "") {
		token.tokens.shift();
	}
	return kind;
}

export async function renderMarkdown(
	markdown: string,
	options: RenderMarkdownOptions = {},
): Promise<ParsedDoc> {
	const { data: frontmatter, body } = parseFrontmatter(markdown);
	const prepared = prepareExplicitAnchors(body);
	const tokens = lexer(prepared);
	const pageSlugs = options.pageSlugs ?? new Set<string>();
	const highlightCodeEnabled = options.highlightCode ?? true;

	const headingIds = new WeakMap<object, string>();
	const headingMeta = new WeakMap<object, DocsHeading>();
	const headings: DocsHeading[] = [];
	const slugger = createSlugger();

	walkTokens(tokens, (token) => {
		if (token.type !== "heading") {
			return;
		}
		const heading = token as Tokens.Heading;
		const marker = headingMarker(heading.text);
		const id = marker.explicitId
			? slugger(marker.explicitId)
			: slugger(marker.cleanText);
		const meta: DocsHeading = {
			id,
			text: plainHeadingText(marker.cleanText),
			depth: heading.depth,
		};
		headingIds.set(token, id);
		headingMeta.set(token, meta);
		if (heading.depth === 2 || heading.depth === 3) {
			headings.push(meta);
		}
	});

	const codeHtml = new WeakMap<object, string>();
	const codeTokens: Tokens.Code[] = [];
	walkTokens(tokens, (token) => {
		if (token.type === "code") {
			codeTokens.push(token as Tokens.Code);
		}
	});
	await Promise.all(
		codeTokens.map(async (token) => {
			const shell = normalizeLang(token.lang) === "bash";
			const packageManagerBlock = shell
				? renderPackageManagerBlock(token.text)
				: null;
			if (packageManagerBlock) {
				codeHtml.set(token, packageManagerBlock);
				return;
			}
			const html = await highlightCode(
				token.text,
				token.lang,
				highlightCodeEnabled,
			);
			codeHtml.set(token, wrapCodeBlock(html, token.lang));
		}),
	);

	const renderer = new DocsRenderer(headingIds, codeHtml, pageSlugs);

	const sections: DocsSection[] = [];
	let currentHeading: DocsHeading | undefined;
	let currentTokens: Token[] = [];
	const flush = () => {
		if (currentTokens.length === 0 && !currentHeading) {
			return;
		}
		const raw = currentTokens
			.map((token) => token.raw)
			.join("")
			.replace(/\s*__NEOORM_ANCHOR_[a-z0-9-]+__\s*/g, " ");
		const excerpt = firstParagraph(raw) || currentHeading?.text || "";
		sections.push({
			...(currentHeading
				? { heading: currentHeading, anchor: currentHeading.id }
				: {}),
			text: plainTextFromMarkdown(raw),
			code: extractCodeIdentifiers(raw),
			excerpt,
		});
		currentTokens = [];
	};

	for (const token of tokens) {
		if (
			token.type === "heading" &&
			(token.depth === 2 || token.depth === 3)
		) {
			flush();
			currentHeading = headingMeta.get(token);
			currentTokens = [token];
			continue;
		}
		currentTokens.push(token);
	}
	flush();

	const html = parser(tokens, { renderer });

	return {
		frontmatter,
		body,
		html,
		headings,
		sections,
	};
}
