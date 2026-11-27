/** Plain-text and frontmatter helpers used by search and the docs renderer. */

export type Frontmatter = {
	data: Record<string, string>;
	body: string;
};

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(markdown: string): Frontmatter {
	const match = markdown.match(FRONTMATTER_PATTERN);
	if (!match) {
		return { data: {}, body: markdown };
	}
	const data: Record<string, string> = {};
	for (const line of match[1]?.split(/\r?\n/) ?? []) {
		const separator = line.indexOf(":");
		if (separator <= 0) {
			continue;
		}
		const key = line.slice(0, separator).trim();
		const value = line
			.slice(separator + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		if (key) {
			data[key] = value;
		}
	}
	return { data, body: markdown.slice(match[0].length) };
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

/** Inline heading text keeps code spans, e.g. "Nested reads (`with`)". */
export function plainHeadingText(markdown: string): string {
	return markdown
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/[*_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Identifiers inside fenced code, so `findMany` is searchable. */
export function extractCodeIdentifiers(markdown: string): string {
	const parts: string[] = [];
	for (const match of markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
		const code = match[1] ?? "";
		for (const identifier of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
			const value = identifier[0];
			if (value.length >= 3) {
				parts.push(value);
			}
		}
	}
	return parts.join(" ");
}

/** First prose paragraph from a markdown section, used for search excerpts. */
export function firstParagraph(markdown: string): string {
	const withoutFences = markdown.replace(/```[\s\S]*?```/g, "");
	for (const block of withoutFences.split(/\n{2,}/)) {
		const trimmed = block.trim();
		if (
			trimmed === "" ||
			trimmed.startsWith("#") ||
			trimmed.startsWith("|") ||
			trimmed.startsWith("-") ||
			trimmed.startsWith("*") ||
			/^\d+\./.test(trimmed)
		) {
			continue;
		}
		return plainTextFromMarkdown(trimmed);
	}
	return plainTextFromMarkdown(withoutFences);
}
