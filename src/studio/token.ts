import { createHash, timingSafeEqual } from "node:crypto";

/** Compare tokens without short-circuiting on the first differing byte. */
export function tokensMatch(provided: string, expected: string): boolean {
	const a = createHash("sha256").update(provided).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}
