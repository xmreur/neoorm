/** HTML escaping helpers shared by the docs renderer. */

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export function escapeAttribute(value: string): string {
	return escapeHtml(value).replaceAll("'", "&#39;");
}

/** Remove tags from already-rendered HTML and decode the common entities. */
export function stripHtml(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&")
		.replace(/\s+/g, " ")
		.trim();
}

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Reject script-capable URLs from markdown. Relative URLs, anchors, and the
 * protocols above are allowed; everything else is dropped.
 */
export function safeHref(href: string): string | null {
	const trimmed = href.trim();
	if (trimmed === "") {
		return null;
	}
	if (
		trimmed.startsWith("#") ||
		trimmed.startsWith("/") ||
		trimmed.startsWith("./") ||
		trimmed.startsWith("../")
	) {
		return trimmed;
	}
	try {
		const url = new URL(trimmed, "http://localhost");
		if (SAFE_PROTOCOLS.has(url.protocol)) {
			return trimmed;
		}
	} catch {
		return null;
	}
	return null;
}
