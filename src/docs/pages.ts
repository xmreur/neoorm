import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export type DocsPage = {
	slug: string;
	title: string;
	fileName: string;
	sourcePath: string;
};

const PAGE_ORDER = [
	"getting-started",
	"schema",
	"queries",
	"relations",
	"transactions",
	"migrations",
	"cli",
	"configuration",
	"sqlite",
	"plugins",
] as const;

function titleFromMarkdown(content: string, fallback: string): string {
	const match = content.match(/^#\s+(.+)$/m);
	return match?.[1]?.trim() ?? fallback;
}

function titleFromSlug(slug: string): string {
	return slug
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export async function loadDocsPages(docsDir: string): Promise<DocsPage[]> {
	const entries = await readdir(docsDir, { withFileTypes: true });
	const pages: DocsPage[] = [];

	for (const entry of entries) {
		if (!entry.isFile() || extname(entry.name) !== ".md") {
			continue;
		}
		const slug = basename(entry.name, ".md");
		pages.push({
			slug,
			title: titleFromSlug(slug),
			fileName: entry.name,
			sourcePath: join(docsDir, entry.name),
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
	const { readFile } = await import("node:fs/promises");
	for (const page of pages) {
		const content = await readFile(page.sourcePath, "utf-8");
		page.title = titleFromMarkdown(content, page.title);
	}
}
