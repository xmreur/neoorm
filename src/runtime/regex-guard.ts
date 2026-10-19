/**
 * Guards SQLite `search`/`REGEXP` against catastrophic-backtracking (ReDoS)
 * patterns.
 *
 * On SQLite the pattern runs as an in-process JavaScript `RegExp` inside the
 * driver's single shared connection, so an exponential-backtracking pattern
 * (e.g. `(a+)+$`) freezes the whole event loop, not just one query.
 * PostgreSQL and MySQL execute REGEXP in the database server, where
 * `statement_timeout` bounds a runaway match, so this guard is SQLite-only.
 *
 * The detector flags the classic nested-unbounded-quantifier shape (star
 * height ≥ 2): an unbounded quantifier (`*`, `+`, `{n,}`) applied to a group
 * whose body itself contains an unbounded quantifier — `(a+)+`, `(a*)*`,
 * `(\d+)+`, `((ab)+)+`. It is a heuristic: overlapping-alternation shapes
 * like `(a|a)*` slip through, and a rare ambiguous-but-practically-linear
 * pattern like `(a+b)+` is rejected. `SqliteClientOptions.unsafeAllowRegex`
 * opts out for the latter case.
 */

const OPEN_ENDED_REPEAT = /\{\d+,\}\??/y;

/** Length of the unbounded quantifier (`*`, `+`, `{n,}`, with optional lazy `?`) at `index`, or 0. */
function unboundedQuantifierLength(pattern: string, index: number): number {
	const ch = pattern[index];
	if (ch === "*" || ch === "+") {
		return pattern[index + 1] === "?" ? 2 : 1;
	}
	if (ch === "{") {
		OPEN_ENDED_REPEAT.lastIndex = index;
		return OPEN_ENDED_REPEAT.exec(pattern)?.[0].length ?? 0;
	}
	return 0;
}

/**
 * Returns true when `pattern` nests an unbounded quantifier inside another
 * unbounded quantifier — the shape that backtracks exponentially. Assumes a
 * syntactically valid pattern (callers compile with `new RegExp` anyway, so
 * malformed input surfaces as a SyntaxError after this returns false).
 */
export function hasCatastrophicBacktracking(pattern: string): boolean {
	// One frame per open group; index 0 is the synthetic top level. Each frame
	// records whether its body contains an unbounded quantifier.
	const frames: boolean[] = [false];
	// True when the preceding atom was itself unbounded-quantified, so a
	// following quantifier wraps it: `a+*` is `(a+)*`.
	let prevQuantifiedAtom = false;

	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];

		if (ch === "\\") {
			i++;
			prevQuantifiedAtom = false;
			continue;
		}
		if (ch === "[") {
			// Character-class contents are literals; skip to the closing bracket.
			i++;
			if (pattern[i] === "^") i++;
			if (pattern[i] === "]") i++;
			while (i < pattern.length && pattern[i] !== "]") {
				if (pattern[i] === "\\") i++;
				i++;
			}
			prevQuantifiedAtom = false;
			continue;
		}
		if (ch === "(") {
			frames.push(false);
			prevQuantifiedAtom = false;
			continue;
		}
		if (ch === ")") {
			if (frames.length === 1) {
				// Unbalanced `)`; RegExp will reject the pattern later.
				prevQuantifiedAtom = false;
				continue;
			}
			const bodyHasQuantifier = frames.pop() ?? false;
			const quantifier = unboundedQuantifierLength(pattern, i + 1);
			// The quantifier wraps the whole group body: nested iff the body
			// itself contains an unbounded quantifier.
			if (bodyHasQuantifier && quantifier > 0) return true;
			if (quantifier > 0) {
				// The quantifier starts at i+1; skip past its last char so it
				// is not re-processed as a fresh quantifier below.
				i += quantifier;
				prevQuantifiedAtom = true;
			} else {
				prevQuantifiedAtom = false;
			}
			// The group's contents (and its quantifier, if any) live inside the
			// parent body: `((a+))+` is star height 2 once the outer group is
			// quantified.
			if (bodyHasQuantifier || quantifier > 0) {
				frames[frames.length - 1] = true;
			}
			continue;
		}
		const quantifier = unboundedQuantifierLength(pattern, i);
		if (quantifier > 0) {
			if (prevQuantifiedAtom) return true;
			i += quantifier - 1;
			frames[frames.length - 1] = true;
			prevQuantifiedAtom = true;
			continue;
		}
		prevQuantifiedAtom = false;
	}

	return false;
}

const MAX_SHOWN_PATTERN_LENGTH = 100;

/** Message for a rejected pattern; safe to surface in query errors. */
export function catastrophicRegexMessage(pattern: string): string {
	const shown =
		pattern.length > MAX_SHOWN_PATTERN_LENGTH
			? `${pattern.slice(0, MAX_SHOWN_PATTERN_LENGTH)}…`
			: pattern;
	return (
		`SQLite REGEXP pattern ${JSON.stringify(shown)} nests unbounded quantifiers ` +
		'(e.g. "(a+)+") and can backtrack exponentially, freezing the process. ' +
		"Simplify the pattern, or pass { unsafeAllowRegex: true } to sqliteClient() to allow it."
	);
}
