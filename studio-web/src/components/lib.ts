/** classnames helper (shadcn-style `cn`). */
export function cn(...parts: (string | false | null | undefined)[]): string {
	return parts
		.filter((p): p is string => typeof p === "string" && p.length > 0)
		.join(" ");
}
