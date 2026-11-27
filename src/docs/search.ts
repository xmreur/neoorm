import { readFile } from "node:fs/promises";
import { renderMarkdown } from "./markdown.js";
import type { DocsPage } from "./pages.js";
import { slugifyHeading } from "./slug.js";
import { plainTextFromMarkdown } from "./text.js";

export type DocsSearchRecord = {
	slug: string;
	title: string;
	description: string;
	group: string;
	heading?: string;
	anchor?: string;
	excerpt: string;
	text: string;
	code: string;
	keywords: string;
	pageOrder: number;
	sectionOrder: number;
};

export type DocsSearchHighlight = {
	start: number;
	end: number;
};

export type DocsSearchHit = DocsSearchRecord & {
	score: number;
	highlights: DocsSearchHighlight[];
};

const MAX_RESULTS = 10;
const EXCERPT_LENGTH = 190;

type FieldWeights = {
	exact: number;
	prefix: number;
	wordPrefix: number;
	includes: number;
};

const TITLE_WEIGHTS: FieldWeights = {
	exact: 120,
	prefix: 80,
	wordPrefix: 60,
	includes: 40,
};
const HEADING_WEIGHTS: FieldWeights = {
	exact: 90,
	prefix: 60,
	wordPrefix: 45,
	includes: 30,
};
const DESCRIPTION_WEIGHTS: FieldWeights = {
	exact: 40,
	prefix: 28,
	wordPrefix: 20,
	includes: 12,
};
const CODE_WEIGHTS: FieldWeights = {
	exact: 48,
	prefix: 36,
	wordPrefix: 32,
	includes: 14,
};
const KEYWORD_WEIGHTS: FieldWeights = {
	exact: 40,
	prefix: 30,
	wordPrefix: 22,
	includes: 12,
};
const TEXT_WEIGHTS: FieldWeights = {
	exact: 24,
	prefix: 16,
	wordPrefix: 12,
	includes: 6,
};

export { plainTextFromMarkdown, slugifyHeading };

function normalize(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenizeQuery(query: string): string[] {
	return normalize(query).match(/[\p{L}\p{N}_#]+/gu) ?? [];
}

function isWordCharacter(value: string | undefined): boolean {
	return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function scoreField(
	field: string,
	token: string,
	weights: FieldWeights,
): number {
	if (field === "") {
		return 0;
	}
	if (field === token) {
		return weights.exact;
	}
	if (field.startsWith(token) && !isWordCharacter(field[token.length])) {
		const rest = field.slice(token.length).trim();
		return rest === "" ? weights.prefix : weights.wordPrefix;
	}
	if (field.startsWith(token)) {
		return weights.prefix;
	}
	let index = field.indexOf(token);
	while (index >= 0) {
		if (!isWordCharacter(field[index - 1])) {
			return weights.wordPrefix;
		}
		index = field.indexOf(token, index + 1);
	}
	return field.includes(token) ? weights.includes : 0;
}

function scoreRecord(record: DocsSearchRecord, tokens: string[]): number {
	if (tokens.length === 0) {
		return 0;
	}
	const title = normalize(record.title);
	const heading = normalize(record.heading ?? "");
	const description = normalize(record.description);
	const text = normalize(record.text);
	const code = normalize(record.code);
	const keywords = normalize(record.keywords);

	let score = 0;
	let matched = 0;
	let strongMatches = 0;

	for (const token of tokens) {
		const fieldScore = Math.max(
			scoreField(title, token, TITLE_WEIGHTS),
			scoreField(heading, token, HEADING_WEIGHTS),
			scoreField(description, token, DESCRIPTION_WEIGHTS),
			scoreField(keywords, token, KEYWORD_WEIGHTS),
			scoreField(code, token, CODE_WEIGHTS),
			scoreField(text, token, TEXT_WEIGHTS),
		);
		if (fieldScore > 0) {
			matched += 1;
			if (fieldScore >= DESCRIPTION_WEIGHTS.wordPrefix) {
				strongMatches += 1;
			}
			score += fieldScore;
		}
	}

	if (matched === 0) {
		return 0;
	}
	if (matched < tokens.length) {
		if (strongMatches === 0 || matched < Math.ceil(tokens.length / 2)) {
			return 0;
		}
		score = Math.round(score * (matched / tokens.length));
	} else {
		score += 50;
	}

	return score;
}

function levenshteinWithinOne(a: string, b: string): boolean {
	if (Math.abs(a.length - b.length) > 1) {
		return false;
	}
	let i = 0;
	let j = 0;
	let edits = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			i += 1;
			j += 1;
			continue;
		}
		edits += 1;
		if (edits > 1) {
			return false;
		}
		if (a.length > b.length) {
			i += 1;
		} else if (b.length > a.length) {
			j += 1;
		} else {
			i += 1;
			j += 1;
		}
	}
	return edits + (a.length - i) + (b.length - j) <= 1;
}

function fuzzyScore(record: DocsSearchRecord, tokens: string[]): number {
	const fields = [
		normalize(record.title),
		normalize(record.heading ?? ""),
		normalize(record.description),
		normalize(record.text),
		normalize(record.code),
		normalize(record.keywords),
	];
	let matched = 0;
	for (const token of tokens) {
		if (token.length < 4) {
			continue;
		}
		const words = fields.flatMap((field) =>
			field.split(/[^\p{L}\p{N}_]+/u),
		);
		if (
			words.some(
				(word) => word.length >= 3 && levenshteinWithinOne(word, token),
			)
		) {
			matched += 1;
		}
	}
	return matched > 0 && matched >= Math.ceil(tokens.length / 2)
		? matched * 8
		: 0;
}

function buildRecord(
	page: DocsPage,
	pageOrder: number,
	sectionOrder: number,
	section: {
		heading?: { text: string; id: string };
		text: string;
		code: string;
		excerpt: string;
	},
): DocsSearchRecord {
	const heading = section.heading;
	return {
		slug: page.slug,
		title: page.title,
		description: page.description,
		group: page.group,
		...(heading ? { heading: heading.text, anchor: heading.id } : {}),
		excerpt: section.excerpt || page.description,
		text: [page.title, page.description, heading?.text, section.text]
			.filter((part): part is string => Boolean(part))
			.join(" "),
		code: section.code,
		keywords: page.keywords,
		pageOrder,
		sectionOrder,
	};
}

export async function buildSearchIndex(
	pages: DocsPage[],
): Promise<DocsSearchRecord[]> {
	const records: DocsSearchRecord[] = [];
	const pageSlugs = new Set(pages.map((page) => page.slug));

	for (const [pageOrder, page] of pages.entries()) {
		if (page.hidden) {
			continue;
		}
		const markdown = await readFile(page.sourcePath, "utf-8");
		const parsed = await renderMarkdown(markdown, {
			pageSlugs,
			highlightCode: false,
		});
		for (const [sectionOrder, section] of parsed.sections.entries()) {
			records.push(buildRecord(page, pageOrder, sectionOrder, section));
		}
	}

	return records;
}

function makeExcerpt(text: string, tokens: string[]): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= EXCERPT_LENGTH) {
		return normalized;
	}
	const lower = normalized.toLowerCase();
	let firstMatch = -1;
	for (const token of tokens) {
		const index = lower.indexOf(token);
		if (index >= 0 && (firstMatch < 0 || index < firstMatch)) {
			firstMatch = index;
		}
	}
	const start = Math.max(
		0,
		firstMatch >= 0 ? firstMatch - Math.floor(EXCERPT_LENGTH / 3) : 0,
	);
	const end = Math.min(normalized.length, start + EXCERPT_LENGTH);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < normalized.length ? "…" : "";
	return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
}

function highlightRanges(
	text: string,
	tokens: string[],
): DocsSearchHighlight[] {
	const lower = text.toLowerCase();
	const ranges: DocsSearchHighlight[] = [];
	for (const token of tokens) {
		if (token.length < 2) {
			continue;
		}
		let index = lower.indexOf(token);
		while (index >= 0) {
			ranges.push({ start: index, end: index + token.length });
			index = lower.indexOf(token, index + token.length);
		}
	}
	ranges.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: DocsSearchHighlight[] = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged.slice(0, 24);
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
			hits.push({ ...record, score, highlights: [] });
		}
	}

	if (hits.length === 0) {
		for (const record of records) {
			const score = fuzzyScore(record, tokens);
			if (score > 0) {
				hits.push({ ...record, score, highlights: [] });
			}
		}
	}

	hits.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		if (a.pageOrder !== b.pageOrder) {
			return a.pageOrder - b.pageOrder;
		}
		return a.sectionOrder - b.sectionOrder;
	});

	return hits.slice(0, MAX_RESULTS);
}

export function searchDocs(
	query: string,
	records: DocsSearchRecord[],
): DocsSearchHit[] {
	const tokens = tokenizeQuery(query);
	return rankSearchResults(query, records).map((hit) => {
		const candidates = [hit.excerpt, hit.text, hit.code];
		const source =
			candidates.find((candidate) =>
				tokens.some((token) => candidate.toLowerCase().includes(token)),
			) ?? hit.excerpt;
		const excerpt = makeExcerpt(source || hit.text, tokens);
		return {
			...hit,
			excerpt,
			highlights: highlightRanges(excerpt, tokens),
		};
	});
}
