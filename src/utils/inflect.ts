/** Nouns that are the same in singular and plural (or have no useful singular). */
const UNCOUNTABLE = new Set([
	"news",
	"series",
	"species",
	"means",
	"barracks",
	"headquarters",
	"aircraft",
	"sheep",
	"deer",
	"fish",
	"moose",
	"salmon",
	"trout",
]);

const IRREGULAR_SINGULAR: Record<string, string> = {
	people: "person",
	children: "child",
	men: "man",
	women: "woman",
	mice: "mouse",
	geese: "goose",
	teeth: "tooth",
	feet: "foot",
};

const CONSONANT = "bcdfghjklmnpqrstvwxz";

function applyCasing(sample: string, replacement: string): string {
	if (sample.length === 0) return replacement;
	if (sample === sample.toUpperCase() && sample.length > 1) {
		return replacement.toUpperCase();
	}
	const first = sample[0];
	if (first !== undefined && first === first.toUpperCase()) {
		return `${replacement.charAt(0).toUpperCase()}${replacement.slice(1)}`;
	}
	return replacement;
}

function lastChar(word: string): string {
	return word.charAt(word.length - 1);
}

function isConsonant(ch: string): boolean {
	return CONSONANT.includes(ch.toLowerCase());
}

/**
 * English singular for schema accessors and generated model type names.
 * Only rewrites known plural patterns — `status` and `address` stay intact.
 */
export function singularize(word: string): string {
	if (word.length === 0) return word;
	const lower = word.toLowerCase();
	if (UNCOUNTABLE.has(lower)) return word;
	const irregular = IRREGULAR_SINGULAR[lower];
	if (irregular !== undefined) return applyCasing(word, irregular);

	if (
		word.length > 4 &&
		isConsonant(word.charAt(word.length - 4)) &&
		/ies$/i.test(word)
	) {
		return `${word.slice(0, -3)}${lastChar(word) === "S" ? "Y" : "y"}`;
	}

	if (/(sses|xes|zes|ches|shes)$/i.test(word)) {
		return word.slice(0, -2);
	}

	// statuses, campuses, buses — not houses (vowel before "uses")
	if (
		word.length >= 5 &&
		isConsonant(word.charAt(word.length - 5)) &&
		/uses$/i.test(word)
	) {
		return word.slice(0, -2);
	}

	if (/(ss|us|is)$/i.test(word)) return word;

	if (/s$/i.test(word) && word.length > 1) {
		return word.slice(0, -1);
	}
	return word;
}
