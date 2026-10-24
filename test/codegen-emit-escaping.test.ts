import { describe, expect, it } from "vitest";
import { emitIncludesTs } from "../src/codegen/emit-includes.js";
import { emitModelsTs } from "../src/codegen/emit-models.js";
import { emitQueryTypesTs } from "../src/codegen/emit-query-types.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { emitZodTs } from "../src/codegen/validation/emit-zod.js";
import { validationFromManifest } from "../src/codegen/validation/from-manifest.js";
import { defineSchema, id, table, text } from "../src/schema/index.js";

describe("generated TypeScript escapes schema names", () => {
	const schema = defineSchema({
		'users"x': table({
			id: id(),
			'a"b\\c': text(),
		}),
	});
	const manifest = schemaToManifest(schema);

	it("quotes hostile names in includes, models, query types, and zod", () => {
		const includes = emitIncludesTs(manifest);
		const models = emitModelsTs(manifest, "neoorm");
		const queries = emitQueryTypesTs(manifest);
		const zod = emitZodTs(validationFromManifest(manifest));
		const literal = JSON.stringify('a"b\\c');
		const accessor = JSON.stringify('users"x');

		for (const source of [includes, models, queries, zod]) {
			expect(source).not.toContain('a"b\\c');
			expect(source).not.toContain('users"x:');
		}
		expect(includes).toContain(accessor);
		expect(queries).toContain(literal);
		expect(models).toContain(`K extends ${accessor}`);
		expect(models).toContain(`${literal}:`);
		expect(zod).toContain(`${literal}:`);
		expect(models).toContain("export interface Users_x");
	});
});
