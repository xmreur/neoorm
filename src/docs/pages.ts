import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { type DocsGroupId, PAGE_META } from "./nav.js";
import { firstParagraph, parseFrontmatter } from "./text.js";

export type DocsPage = {
	slug: string;
	title: string;
	description: string;
	group: DocsGroupId;
	order: number;
	keywords: string;
	hidden: boolean;
	fileName: string;
	sourcePath: string;
};

const PAGE_ORDER = [
	"getting-started",
	"examples",
	"schema",
	"zod",
	"typebox",
	"elysia",
	"queries",
	"relations",
	"transactions",
	"migrations",
	"errors",
	"cli",
	"studio",
	"configuration",
	"sqlite",
	"mysql",
	"mariadb",
	"plugins",
] as const;

function titleFromMarkdown(content: string, fallback: string): string {
	const { body, data } = parseFrontmatter(content);
	if (data.title) {
		return data.title;
	}
	const match = body.match(/^#\s+(.+)$/m);
	return match?.[1]?.trim() ?? fallback;
}

function descriptionFromMarkdown(content: string, fallback: string): string {
	const { body, data } = parseFrontmatter(content);
	if (data.description) {
		return data.description;
	}
	if (fallback) {
		return fallback;
	}
	return firstParagraph(body.replace(/^#\s+.+$/m, ""));
}

function titleFromSlug(slug: string): string {
	return slug
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function metaFor(slug: string): {
	group: DocsGroupId;
	order: number;
	description: string;
	keywords: string;
	hidden: boolean;
} {
	const meta = PAGE_META[slug];
	return {
		group: meta?.group ?? "guides",
		order: meta?.order ?? 999,
		description: meta?.description ?? "",
		keywords: meta?.keywords ?? "",
		hidden: meta?.hidden ?? false,
	};
}

export async function loadDocsPages(docsDir: string): Promise<DocsPage[]> {
	const entries = await readdir(docsDir, { withFileTypes: true });
	const pages: DocsPage[] = [];

	for (const entry of entries) {
		if (!entry.isFile() || extname(entry.name) !== ".md") {
			continue;
		}
		const slug = basename(entry.name, ".md");
		const sourcePath = join(docsDir, entry.name);
		const content = await readFile(sourcePath, "utf-8");
		const meta = metaFor(slug);
		pages.push({
			slug,
			title: titleFromMarkdown(content, titleFromSlug(slug)),
			description: descriptionFromMarkdown(content, meta.description),
			group: meta.group,
			order: meta.order,
			keywords: meta.keywords,
			hidden: meta.hidden,
			fileName: entry.name,
			sourcePath,
		});
	}

	const order = new Map(
		PAGE_ORDER.map((slug, index) => [slug, index] as const),
	);
	pages.sort((a, b) => {
		const aOrder = order.get(a.slug as (typeof PAGE_ORDER)[number]);
		const bOrder = order.get(b.slug as (typeof PAGE_ORDER)[number]);
		if (aOrder !== undefined && bOrder !== undefined) {
			return aOrder - bOrder;
		}
		if (aOrder !== undefined) return -1;
		if (bOrder !== undefined) return 1;
		return a.slug.localeCompare(b.slug);
	});

	return pages;
}

export async function hydratePageTitles(pages: DocsPage[]): Promise<void> {
	for (const page of pages) {
		const content = await readFile(page.sourcePath, "utf-8");
		const meta = metaFor(page.slug);
		page.title = titleFromMarkdown(content, page.title);
		page.description = descriptionFromMarkdown(content, meta.description);
	}
}
