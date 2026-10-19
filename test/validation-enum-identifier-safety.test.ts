import { describe, expect, it } from "vitest";
import { buildEnumRegistry } from "../src/codegen/column-ts.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { emitElysiaTs } from "../src/codegen/validation/emit-elysia.js";
import { emitTypeboxTs } from "../src/codegen/validation/emit-typebox.js";
import { emitZodTs } from "../src/codegen/validation/emit-zod.js";
import { validationFromManifest } from "../src/codegen/validation/from-manifest.js";
import { defineSchema, enumType, id, table } from "../src/schema/index.js";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `export const <name>Schema = ...` identifiers emitted by any emitter. */
function exportedEnumSchemaNames(emitted: string): string[] {
	return [...emitted.matchAll(/export const (\S+)Schema = /g)].flatMap(
		(match) => {
			const name = match[1];
			return name !== undefined ? [name] : [];
		},
	);
}

function emittedFor(enumName: string): {
	zod: string;
	typebox: string;
	elysia: string;
} {
	const schema = defineSchema({
		posts: table({
			id: id(),
			status: enumType(["draft", "published"], { name: enumName }),
		}),
	});
	const ir = validationFromManifest(schemaToManifest(schema));
	return {
		zod: emitZodTs(ir),
		typebox: emitTypeboxTs(ir),
		elysia: emitElysiaTs(ir),
	};
}

describe("generated enum identifiers are sanitized", () => {
	// Simulates a hostile DB enum type name flowing through
	// `neoorm pull` → `enumType([...], { name })` → schemaToManifest.
	const hostile = 'Evil = 0;console.log("PWNED");//';

	it("neutralizes code injection from a hostile enum type name (zod)", () => {
		const { zod } = emittedFor(hostile);

		// punctuation that enabled the breakout is stripped
		expect(zod).not.toContain("console.log");
		expect(zod).not.toContain('"PWNED"');
		expect(zod).not.toMatch(/export const [^A-Za-z_$\s]/);
		for (const name of exportedEnumSchemaNames(zod)) {
			expect(name).toMatch(IDENTIFIER);
		}
		expect(zod).toContain('z.enum(["draft","published"])');
	});

	it("neutralizes code injection in typebox and elysia emitters", () => {
		for (const emitted of [
			emittedFor(hostile).typebox,
			emittedFor(hostile).elysia,
		]) {
			expect(emitted).not.toContain("console.log");
			expect(emitted).not.toContain('"PWNED"');
			for (const name of exportedEnumSchemaNames(emitted)) {
				expect(name).toMatch(IDENTIFIER);
			}
		}
	});

	it("keeps field references aligned with the sanitized export", () => {
		const { zod } = emittedFor(hostile);
		const [name] = exportedEnumSchemaNames(zod);
		expect(name).toBeDefined();
		expect(zod).toContain(`status: ${name}Schema`);
		expect(zod).toContain(`export type ${name} = z.infer`);
	});

	it("prefixes digit-leading enum names", () => {
		const { zod } = emittedFor("3dMode");
		for (const name of exportedEnumSchemaNames(zod)) {
			expect(name).toMatch(IDENTIFIER);
		}
		expect(zod).not.toMatch(/export const \d/);
	});

	it("falls back to a valid identifier for all-punctuation names", () => {
		const { zod } = emittedFor('";');
		for (const name of exportedEnumSchemaNames(zod)) {
			expect(name).toMatch(IDENTIFIER);
		}
		expect(zod).toContain('z.enum(["draft","published"])');
	});

	it("keeps distinct enum types exported under unique identifiers", () => {
		const schema = defineSchema({
			posts: table({
				id: id(),
				a: enumType(["draft"], { name: "foo-bar" }),
				b: enumType(["published"], { name: "foo.bar" }),
			}),
		});
		const ir = validationFromManifest(schemaToManifest(schema));
		const names = ir.enums.map((entry) => entry.name);

		expect(new Set(names).size).toBe(names.length);
		for (const name of names) expect(name).toMatch(IDENTIFIER);

		const zod = emitZodTs(ir);
		for (const name of names) {
			expect(zod).toContain(`export const ${name}Schema = `);
		}
		// both keep their own values
		expect(zod).toContain('z.enum(["draft"])');
		expect(zod).toContain('z.enum(["published"])');
	});

	it("leaves well-formed enum names untouched", () => {
		const { zod } = emittedFor("PostStatus");
		expect(exportedEnumSchemaNames(zod)).toContain("PostStatus");
	});

	it("sanitizes enum aliases in the models/query-types registry", () => {
		const schema = defineSchema({
			posts: table({
				id: id(),
				status: enumType(["draft", "published"], { name: hostile }),
			}),
		});
		const registry = buildEnumRegistry(schemaToManifest(schema));

		expect(registry.declarations.length).toBeGreaterThan(0);
		expect(registry.declarations.join("\n")).not.toContain("console.log");
		for (const decl of registry.declarations) {
			expect(decl).toMatch(/^export type [A-Za-z_$][A-Za-z0-9_$]* =/);
		}
	});
});
