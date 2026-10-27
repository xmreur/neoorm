export const SQL_HISTORY_KEY = "neoorm-studio-sql-history";
export const SQL_HISTORY_LIMIT = 20;

type HistoryStore = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};

/** Read SQL history, keeping only strings. Poisoned values are removed. */
export function loadSqlHistory(
	store: HistoryStore,
	key = SQL_HISTORY_KEY,
): string[] {
	let raw: string | null;
	try {
		raw = store.getItem(key);
	} catch {
		return [];
	}
	if (raw === null) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		remove(store, key);
		return [];
	}
	if (!Array.isArray(parsed)) {
		remove(store, key);
		return [];
	}

	const history = parsed
		.filter((entry): entry is string => typeof entry === "string")
		.slice(0, SQL_HISTORY_LIMIT);
	if (history.length !== parsed.length || parsed.length > SQL_HISTORY_LIMIT) {
		try {
			store.setItem(key, JSON.stringify(history));
		} catch {
			// The in-memory list is still safe if storage is unavailable.
		}
	}
	return history;
}

function remove(store: HistoryStore, key: string): void {
	try {
		store.removeItem(key);
	} catch {
		// Ignore storage failures; the caller still gets an empty history.
	}
}
