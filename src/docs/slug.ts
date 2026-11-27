/** Heading slug helpers shared by the renderer and the search index. */

export function slugifyHeading(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

export function createSlugger(): (text: string) => string {
	const used = new Set<string>();
	return (text: string) => {
		const base = slugifyHeading(text) || "section";
		let slug = base;
		let counter = 1;
		while (used.has(slug)) {
			slug = `${base}-${counter}`;
			counter += 1;
		}
		used.add(slug);
		return slug;
	};
}
