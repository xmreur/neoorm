import { describe, expect, it } from "vitest";
import { resolveModuleExport } from "./load-ts.js";

describe("resolveModuleExport", () => {
	it("returns a direct named export", () => {
		expect(resolveModuleExport({ schema: "direct" }, "schema")).toBe(
			"direct",
		);
	});

	it("reads the named export from the default object", () => {
		expect(
			resolveModuleExport({ default: { schema: "nested" } }, "schema"),
		).toBe("nested");
	});

	it("returns undefined when the named export is missing", () => {
		const whole = { other: 1, _tables: { users: {} } };
		expect(
			resolveModuleExport({ default: whole }, "schema"),
		).toBeUndefined();
		expect(resolveModuleExport({}, "schema")).toBeUndefined();
		expect(
			resolveModuleExport({ default: null }, "schema"),
		).toBeUndefined();
	});
});
