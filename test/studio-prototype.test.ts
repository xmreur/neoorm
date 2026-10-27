import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { defineSchema, id, jsonb, table, text } from "../src/schema/index.js";
import { decodeStudioData, decodeStudioValue } from "../src/studio/codec.js";

const users = schemaToManifest(
	defineSchema({
		users: table({
			id: id(),
			email: text(),
			meta: jsonb(),
		}),
	}),
	[],
	{ provider: "sqlite" },
).tables.users;

describe("studio request object keys", () => {
	it("does not let __proto__ replace the decoded object's prototype", () => {
		const decoded = decodeStudioValue(
			JSON.parse(
				'{"__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}},"email":"a@b.c"}',
			),
		) as { admin?: unknown; email?: unknown };

		expect(decoded.email).toBe("a@b.c");
		expect(decoded.admin).toBeUndefined();
		expect(Object.hasOwn(decoded, "__proto__")).toBe(false);
		expect(Object.hasOwn(decoded, "constructor")).toBe(false);
		expect((Object.prototype as { admin?: unknown }).admin).toBeUndefined();
	});

	it("strips prototype keys nested inside objects and JSON columns", () => {
		if (!users) throw new Error("missing users table");
		const decoded = decodeStudioData(
			users,
			JSON.parse(
				'{"__proto__":{"email":"pwn@x.c"},"email":"ok@x.c","meta":"{\\"__proto__\\":{\\"role\\":\\"admin\\"},\\"ok\\":1}"}',
			) as Record<string, unknown>,
		) as {
			email?: unknown;
			meta?: { role?: unknown; ok?: unknown };
		};

		expect(decoded.email).toBe("ok@x.c");
		expect(decoded.meta?.ok).toBe(1);
		expect(decoded.meta?.role).toBeUndefined();
		expect((Object.prototype as { role?: unknown }).role).toBeUndefined();
	});
});
