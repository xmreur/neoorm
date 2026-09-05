import { readFile } from "node:fs/promises";
import type { DocsPage } from "./pages.js";

export type DocsSearchRecord = {
	slug: string;
	title: string;
	heading?: string;
	anchor?: string;
	excerpt: string;
	text: string;
};

export type DocsSearchHit = DocsSearchRecord & {
	score: number;
};

const EXCERPT_LENGTH = 120;
const MAX_RESULTS = 8;

type MarkdownSection = {
	heading?: string;
	body: string;
};

export function slugifyHeading(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

export function plainTextFromMarkdown(markdown: string): string {
	let text = markdown;
	text = text.replace(/^---[\s\S]*?---\n?/m, "");
	text = text.replace(/```[\s\S]*?```/g, " ");
	text = text.replace(/`[^`]*`/g, " ");
	text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
	text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	text = text.replace(/^#{1,6}\s+/gm, "");
	text = text.replace(/^\s*[-*+]\s+/gm, "");
	text = text.replace(/^\s*\d+\.\s+/gm, "");
	text = text.replace(/[*_~]/g, "");
	text = text.replace(/\|/g, " ");
	text = text.replace(/\s+/g, " ");
	return text.trim();
}

function excerptFromText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= EXCERPT_LENGTH) {
		return normalized;
	}
	return `${normalized.slice(0, EXCERPT_LENGTH).trimEnd()}…`;
}

function parseMarkdownSections(markdown: string): MarkdownSection[] {
	const lines = markdown.split("\n");
	const sections: MarkdownSection[] = [];
	let intro: string[] = [];
	let currentHeading: string | undefined;
	let currentBody: string[] = [];

	const flush = () => {
		const body = currentBody.join("\n").trim();
		if (currentHeading !== undefined || body.length > 0) {
			sections.push({
				...(currentHeading ? { heading: currentHeading } : {}),
				body,
			});
		}
		currentHeading = undefined;
		currentBody = [];
	};

	for (const line of lines) {
		const headingMatch = line.match(/^#{2,3}\s+(.+)$/);
		if (headingMatch) {
			if (currentHeading === undefined && intro.length > 0) {
				sections.push({ body: intro.join("\n").trim() });
				intro = [];
			} else if (currentHeading !== undefined || currentBody.length > 0) {
				flush();
			}
			currentHeading = headingMatch[1]?.trim();
			continue;
		}

		if (currentHeading === undefined && sections.length === 0 && !line.match(/^#\s+/)) {
			intro.push(line);
			continue;
		}

		currentBody.push(line);
	}

	if (currentHeading === undefined && intro.length > 0) {
		sections.push({ body: intro.join("\n").trim() });
	} else {
		flush();
	}

	return sections.filter((section) => section.body.length > 0 || section.heading);
}

function buildRecord(
	page: DocsPage,
	section: MarkdownSection,
): DocsSearchRecord | null {
	const bodyText = plainTextFromMarkdown(section.body);
	if (!bodyText && !section.heading) {
		return null;
	}

	const heading = section.heading;
	const searchableParts = [page.title];
	if (heading) searchableParts.push(heading);
	if (bodyText) searchableParts.push(bodyText);

	const text = searchableParts.join(" ");
	const excerptSource = bodyText || heading || page.title;

	return {
		slug: page.slug,
		title: page.title,
		...(heading
			? { heading, anchor: slugifyHeading(heading) }
			: {}),
		excerpt: excerptFromText(excerptSource),
		text,
	};
}

export async function buildSearchIndex(
	pages: DocsPage[],
): Promise<DocsSearchRecord[]> {
	const records: DocsSearchRecord[] = [];

	for (const page of pages) {
		const markdown = await readFile(page.sourcePath, "utf-8");
		const sections = parseMarkdownSections(markdown);

		for (const section of sections) {
			const record = buildRecord(page, section);
			if (record) {
				records.push(record);
			}
		}

		if (sections.length === 0) {
			const text = plainTextFromMarkdown(markdown);
			if (text) {
				records.push({
					slug: page.slug,
					title: page.title,
					excerpt: excerptFromText(text),
					text: `${page.title} ${text}`,
				});
			}
		}
	}

	return records;
}

function tokenizeQuery(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

function scoreRecord(record: DocsSearchRecord, tokens: string[]): number {
	if (tokens.length === 0) {
		return 0;
	}

	const title = record.title.toLowerCase();
	const heading = record.heading?.toLowerCase() ?? "";
	const text = record.text.toLowerCase();
	let score = 0;

	for (const token of tokens) {
		if (title === token) {
			score += 10;
		} else if (title.startsWith(token)) {
			score += 8;
		} else if (title.includes(token)) {
			score += 5;
		}

		if (heading === token) {
			score += 6;
		} else if (heading.startsWith(token)) {
			score += 5;
		} else if (heading.includes(token)) {
			score += 4;
		}

		if (text.includes(token)) {
			score += 3;
			const occurrences = text.split(token).length - 1;
			if (occurrences > 1) {
				score += Math.min(occurrences - 1, 3);
			}
		}
	}

	return score;
}

export function rankSearchResults(
	query: string,
	records: DocsSearchRecord[],
): DocsSearchHit[] {
	const tokens = tokenizeQuery(query);
	if (tokens.length === 0) {
		return [];
	}

	const hits: DocsSearchHit[] = [];
	for (const record of records) {
		const score = scoreRecord(record, tokens);
		if (score > 0) {
			hits.push({ ...record, score });
		}
	}

	hits.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		return a.title.localeCompare(b.title);
	});

	return hits.slice(0, MAX_RESULTS);
}
