import { describe, expect, it } from "vitest";
import {
	loadSqlHistory,
	SQL_HISTORY_KEY,
	SQL_HISTORY_LIMIT,
} from "../studio-web/src/sql-history.js";

function memoryStore(initial?: string): {
	store: {
		getItem(key: string): string | null;
		setItem(key: string, value: string): void;
		removeItem(key: string): void;
	};
	read(): string | null;
} {
	const values = new Map<string, string>();
	if (initial !== undefined) values.set(SQL_HISTORY_KEY, initial);
	return {
		store: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
			removeItem: (key) => {
				values.delete(key);
			},
		},
		read: () => values.get(SQL_HISTORY_KEY) ?? null,
	};
}

describe("SQL console history", () => {
	it("keeps a list of query strings", () => {
		const { store, read } = memoryStore(
			JSON.stringify(["select 1", "select 2"]),
		);
		expect(loadSqlHistory(store)).toEqual(["select 1", "select 2"]);
		expect(read()).toBe(JSON.stringify(["select 1", "select 2"]));
	});

	it("drops poisoned values and rewrites storage", () => {
		const { store, read } = memoryStore(
			JSON.stringify(["select 1", 2, { sql: "drop table users" }, null]),
		);
		expect(loadSqlHistory(store)).toEqual(["select 1"]);
		expect(read()).toBe(JSON.stringify(["select 1"]));
	});

	it("removes storage that is not an array", () => {
		const objectStore = memoryStore(JSON.stringify({ 0: "select 1" }));
		expect(loadSqlHistory(objectStore.store)).toEqual([]);
		expect(objectStore.read()).toBeNull();

		const broken = memoryStore("{");
		expect(loadSqlHistory(broken.store)).toEqual([]);
		expect(broken.read()).toBeNull();
	});

	it("caps the stored list", () => {
		const queries = Array.from(
			{ length: SQL_HISTORY_LIMIT + 5 },
			(_, i) => `select ${i}`,
		);
		const { store, read } = memoryStore(JSON.stringify(queries));
		expect(loadSqlHistory(store)).toHaveLength(SQL_HISTORY_LIMIT);
		expect(JSON.parse(read() ?? "[]")).toHaveLength(SQL_HISTORY_LIMIT);
	});
});
