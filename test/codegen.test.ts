import { describe, it, expect } from "vitest";
import { generateFromSchema } from "../src/codegen/generate.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { rm } from "node:fs/promises";

describe("codegen", () => {
  const outDir = join(import.meta.dirname, "../examples/blog/neoorm-test-out");

  it("generates manifest and client from schema file", async () => {
    await rm(outDir, { recursive: true, force: true });

    const schemaPath = join(import.meta.dirname, "../examples/blog/schema.ts");
    const { manifest } = await generateFromSchema(schemaPath, outDir);

    expect(manifest.version).toBe(1);
    expect(manifest.tables["users"]).toBeDefined();

    const manifestContent = await readFile(join(outDir, "manifest.ts"), "utf-8");
    expect(manifestContent).toContain('from "neoorm"');
    expect(manifestContent).toContain("export const manifest");

    const clientContent = await readFile(join(outDir, "client.ts"), "utf-8");
    expect(clientContent).toContain('from "neoorm"');
    expect(clientContent).toContain("createNeoOrmClient");
    expect(clientContent).toContain("TypedNeoOrmClient");
    expect(clientContent).toContain("NeoOrmIncludes");

    const includesContent = await readFile(join(outDir, "includes.ts"), "utf-8");
    expect(includesContent).toContain("export type UsersWith");
    expect(includesContent).toContain("profile?:");
    expect(includesContent).toContain("_count?:");

    const modelsContent = await readFile(join(outDir, "models.ts"), "utf-8");
    expect(modelsContent).toContain("export type User = {");
    expect(modelsContent).toContain("export type UserPayload =");
    expect(modelsContent).toContain("export type NeoOrmRowPayloads =");

    await rm(outDir, { recursive: true, force: true });
  });
});
