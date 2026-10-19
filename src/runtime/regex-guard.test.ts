import { describe, expect, it } from "vitest";
import {
	catastrophicRegexMessage,
	hasCatastrophicBacktracking,
} from "./regex-guard.js";

describe("hasCatastrophicBacktracking", () => {
	it.each([
		"(a+)+",
		"(a*)*",
		"(a+)*",
		"(a*)+",
		"(a+)+$",
		"^(a+)+$",
		"(\\d+)+",
		"((ab)+)+",
		"(?:x+){2,}",
		"(\\w+\\s*)+",
		"(a{2,})+",
		"a+*",
		"(a+){3,}",
	])("flags nested unbounded quantifiers: %s", (pattern) => {
		expect(hasCatastrophicBacktracking(pattern)).toBe(true);
	});

	it.each([
		"(a)+",
		"a+",
		"^foo$",
		"[a+]+",
		"([a+])+",
		"https?://",
		"a+b+",
		"foo{2,3}",
		"(?:ab)+",
		"(foo|bar)+",
		"(\\+\\+)+",
		"\\+",
		"(a+)?",
		"(a+){2,3}",
		"[0-9]+\\.[0-9]+",
	])("allows benign patterns: %s", (pattern) => {
		expect(hasCatastrophicBacktracking(pattern)).toBe(false);
	});

	it.each([
		")",
		"(a+",
		"[a+",
		"{2,}",
		"(?",
		"[]",
	])("does not throw on malformed input: %s", (pattern) => {
		expect(() => hasCatastrophicBacktracking(pattern)).not.toThrow();
	});
});

describe("catastrophicRegexMessage", () => {
	it("names the pattern and the opt-out", () => {
		const message = catastrophicRegexMessage("(a+)+$");
		expect(message).toContain("(a+)+$");
		expect(message).toContain("unsafeAllowRegex");
	});

	it("truncates very long patterns", () => {
		const message = catastrophicRegexMessage("a".repeat(500));
		expect(message).toContain(`${"a".repeat(100)}…`);
		expect(message).not.toContain("a".repeat(101));
	});
});
