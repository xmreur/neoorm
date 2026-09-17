import { CappedMap } from "./query/table-index.js";

/**
 * Convert `$N` placeholders to positional `?` and expand params so each `?`
 * is bound once (mysql2 does not support numbered placeholders).
 */

export type PositionalPlan = {
	sql: string;
	slots: number[];
};

const NUMBERED_PLACEHOLDER = /\$\d/;
const PLAN_CACHE_MAX = 1000;
const planCache = new CappedMap<string, PositionalPlan>(PLAN_CACHE_MAX);

export function planNumberedToPositional(sql: string): PositionalPlan | null {
	if (!NUMBERED_PLACEHOLDER.test(sql)) return null;

	let out = "";
	const slots: number[] = [];
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const next = sql[i + 1];

		if (inLineComment) {
			out += ch;
			if (ch === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			out += ch;
			if (ch === "*" && next === "/") {
				out += next;
				i++;
				inBlockComment = false;
			}
			continue;
		}
		if (inSingle) {
			out += ch;
			if (ch === "'") {
				if (next === "'") {
					out += next;
					i++;
				} else {
					inSingle = false;
				}
			}
			continue;
		}
		if (inDouble) {
			out += ch;
			if (ch === '"') {
				if (next === '"') {
					out += next;
					i++;
				} else {
					inDouble = false;
				}
			}
			continue;
		}
		if (inBacktick) {
			out += ch;
			if (ch === "`") {
				if (next === "`") {
					out += next;
					i++;
				} else {
					inBacktick = false;
				}
			}
			continue;
		}
		if (ch === "-" && next === "-") {
			inLineComment = true;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			out += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			out += ch;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			out += ch;
			continue;
		}
		if (ch === "`") {
			inBacktick = true;
			out += ch;
			continue;
		}
		if (ch === "$" && next !== undefined && /\d/.test(next)) {
			let j = i + 1;
			while (j < sql.length && /\d/.test(sql[j] ?? "")) j++;
			const index = Number(sql.slice(i + 1, j));
			out += "?";
			slots.push(index);
			i = j - 1;
			continue;
		}
		out += ch;
	}

	return { sql: out, slots };
}

export function applyPositionalPlan(
	plan: PositionalPlan | null,
	sql: string,
	params: unknown[],
): { sql: string; params: unknown[] } {
	if (!plan) return { sql, params };
	return {
		sql: plan.sql,
		params: plan.slots.map((index) => params[index - 1] ?? null),
	};
}

function planNumberedToPositionalCached(sql: string): PositionalPlan | null {
	if (!NUMBERED_PLACEHOLDER.test(sql)) return null;
	const cached = planCache.get(sql);
	if (cached) return cached;
	const plan = planNumberedToPositional(sql);
	if (plan) planCache.set(sql, plan);
	return plan;
}

export function convertNumberedToPositional(
	sql: string,
	params: unknown[],
): { sql: string; params: unknown[] } {
	return applyPositionalPlan(
		planNumberedToPositionalCached(sql),
		sql,
		params,
	);
}
