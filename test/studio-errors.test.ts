import { describe, expect, it } from "vitest";
import { NeoOrmDriverError } from "../src/runtime/errors.js";
import { toStudioError } from "../src/studio/errors.js";

describe("studio error mapping", () => {
	it("hides absolute paths from unexpected errors", () => {
		const mapped = toStudioError(
			Object.assign(
				new Error("ENOENT: no such file /home/secret/schema.ts"),
				{
					code: "ENOENT",
				},
			),
		);
		expect(mapped.status).toBe(500);
		expect(mapped.body.error).toEqual({
			code: "internal",
			message: "Internal server error",
		});
		expect(JSON.stringify(mapped.body)).not.toContain("/home/secret");
	});

	it("hides driver text from unavailable errors", () => {
		const mapped = toStudioError(
			new NeoOrmDriverError(
				"SELECT 1",
				new Error(
					"unable to open database file /var/lib/neoorm/app.sqlite",
				),
			),
		);
		expect(mapped.status).toBe(503);
		expect(mapped.body.error.code).toBe("driver_error");
		expect(mapped.body.error.message).toBe("Database unavailable");
		expect(JSON.stringify(mapped.body)).not.toContain("/var/lib");
	});
});
