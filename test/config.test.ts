import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

async function withConfigFile<T>(
	content: string,
	run: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "neoorm-config-"));
	try {
		await writeFile(join(dir, "neoorm.config.ts"), content);
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function configSource(datasource: string): string {
	return `
export default {
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: ${datasource},
};
`;
}

describe("config validation", () => {
	it("loads a valid config", async () => {
		await withConfigFile(
			configSource(`{
    provider: "postgresql",
    url: "postgresql://postgres:postgres@localhost:5432/app",
  }`),
			async (dir) => {
				const config = await loadConfig(dir);
				expect(config.datasource.provider).toBe("postgresql");
				expect(config.datasource.url).toBe(
					"postgresql://postgres:postgres@localhost:5432/app",
				);
			},
		);
	});

	it("throws the required shape error for missing required fields", async () => {
		await withConfigFile(
			`
export default {
  schema: "./schema.ts",
  datasource: { provider: "postgresql" },
};
`,
			async (dir) => {
				await expect(loadConfig(dir)).rejects.toThrow(
					"neoorm.config.ts must export defineConfig({ schema, out, datasource: { provider, url } })",
				);
			},
		);
	});

	it("rejects unsupported datasource providers", async () => {
		await withConfigFile(
			configSource(`{
    provider: "mysql",
    url: "mysql://root@localhost/app",
  }`),
			async (dir) => {
				await expect(loadConfig(dir)).rejects.toThrow(
					"neoorm.config.ts datasource.provider must be one of: postgresql",
				);
			},
		);
	});

	it("rejects invalid enum modes", async () => {
		await withConfigFile(
			configSource(`{
    provider: "postgresql",
    url: "postgresql://postgres:postgres@localhost:5432/app",
    enum: "json",
  }`),
			async (dir) => {
				await expect(loadConfig(dir)).rejects.toThrow(
					"neoorm.config.ts datasource.enum must be one of: check, union, native",
				);
			},
		);
	});

	it.each(["check", "union", "native"] as const)(
		"accepts enum mode %s",
		async (enumMode) => {
			await withConfigFile(
				configSource(`{
    provider: "postgresql",
    url: "postgresql://postgres:postgres@localhost:5432/app",
    enum: "${enumMode}",
  }`),
				async (dir) => {
					const config = await loadConfig(dir);
					expect(config.datasource.enum).toBe(enumMode);
				},
			);
		},
	);

	it("rejects a non-string datasource schema", async () => {
		await withConfigFile(
			configSource(`{
    provider: "postgresql",
    url: "postgresql://postgres:postgres@localhost:5432/app",
    schema: 123,
  }`),
			async (dir) => {
				await expect(loadConfig(dir)).rejects.toThrow(
					"neoorm.config.ts datasource.schema must be a string",
				);
			},
		);
	});
});
