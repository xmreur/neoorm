import { describe, expect, it } from "vitest";
import { emitModelsTs } from "../src/codegen/emit-models.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { defineSchema, id, table, text } from "../src/schema/index.js";

describe("emitModelsTs", () => {
	it("wraps payload types with StripCapablePayload and hidden keys", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				email: text().notNull(),
				password: text().notNull().hidden(),
			}),
		});
		const models = emitModelsTs(schemaToManifest(schema));
		expect(models).toContain(
			'import type { StripCapablePayload } from "neoorm";',
		);
		expect(models).toContain(
			'export type UserPayload = StripCapablePayload<User, "password">;',
		);
	});
});
