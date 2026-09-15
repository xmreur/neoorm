import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSchemaToManifest } from "../src/codegen/generate.js";
import { emitZodTs } from "../src/codegen/validation/emit-zod.js";
import { validationFromManifest } from "../src/codegen/validation/from-manifest.js";
import type { ValidationField } from "../src/codegen/validation/types.js";
import { defined } from "./helpers/manifest.js";

function tableNamed(
	ir: ReturnType<typeof validationFromManifest>,
	accessor: string,
) {
	return defined(
		ir.tables.find((table) => table.accessor === accessor),
		`table ${accessor}`,
	);
}

function fieldNamed(fields: ValidationField[], name: string): ValidationField {
	return defined(
		fields.find((field) => field.name === name),
		`field ${name}`,
	);
}

describe("json/jsonb generic type arguments for Zod", () => {
	it("maps inline object generics to validation object IR", async () => {
		const tmpRoot = join(import.meta.dirname, ".tmp");
		await mkdir(tmpRoot, { recursive: true });
		const dir = await mkdtemp(join(tmpRoot, "json-generic-"));
		const schemaPath = join(dir, "schema.ts");
		try {
			await writeFile(
				schemaPath,
				`import { defineSchema, id, jsonb, table } from "neoorm/schema";

export const schema = defineSchema({
  posts: table({
    id: id(),
    metadata: jsonb<{ featured: boolean; category?: string }>(),
  }),
});
`,
				"utf-8",
			);
			const { manifest } = await compileSchemaToManifest(schemaPath, {
				zod: true,
			});
			const posts = manifest.tables.posts;
			const metadata = posts?.columns.find(
				(col) => col.tsName === "metadata",
			);
			expect(metadata?.validation).toEqual({
				kind: "object",
				fields: [
					{
						name: "featured",
						type: { kind: "boolean" },
						nullable: false,
						optional: false,
					},
					{
						name: "category",
						type: { kind: "string" },
						nullable: false,
						optional: true,
					},
				],
			});

			const zod = emitZodTs(validationFromManifest(manifest));
			expect(zod).toContain(
				"metadata: z.object({ featured: z.boolean(), category: z.string().optional() }).nullable()",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps Record<string, unknown> as z.record", async () => {
		const tmpRoot = join(import.meta.dirname, ".tmp");
		await mkdir(tmpRoot, { recursive: true });
		const dir = await mkdtemp(join(tmpRoot, "json-generic-"));
		const schemaPath = join(dir, "schema.ts");
		try {
			await writeFile(
				schemaPath,
				`import { defineSchema, id, jsonb, table } from "neoorm/schema";

export const schema = defineSchema({
  posts: table({
    id: id(),
    metadata: jsonb<Record<string, unknown>>(),
  }),
});
`,
				"utf-8",
			);
			const { manifest } = await compileSchemaToManifest(schemaPath, {
				zod: true,
			});
			const ir = validationFromManifest(manifest);
			const posts = tableNamed(ir, "posts");
			expect(fieldNamed(posts.select, "metadata").type).toEqual({
				kind: "record",
				key: { kind: "string" },
				value: { kind: "unknown" },
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not override explicit .schema() validation", async () => {
		const tmpRoot = join(import.meta.dirname, ".tmp");
		await mkdir(tmpRoot, { recursive: true });
		const dir = await mkdtemp(join(tmpRoot, "json-generic-"));
		const schemaPath = join(dir, "schema.ts");
		try {
			await writeFile(
				schemaPath,
				`import { defineSchema, id, jsonb, table } from "neoorm/schema";

export const schema = defineSchema({
  posts: table({
    id: id(),
    metadata: jsonb<{ ignored: boolean }>().schema({
      kind: "object",
      fields: [
        {
          name: "featured",
          type: { kind: "boolean" },
          nullable: false,
          optional: false,
        },
      ],
    }),
  }),
});
`,
				"utf-8",
			);
			const { manifest } = await compileSchemaToManifest(schemaPath, {
				zod: true,
			});
			const metadata = manifest.tables.posts?.columns.find(
				(col) => col.tsName === "metadata",
			);
			expect(metadata?.validation).toEqual({
				kind: "object",
				fields: [
					{
						name: "featured",
						type: { kind: "boolean" },
						nullable: false,
						optional: false,
					},
				],
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
