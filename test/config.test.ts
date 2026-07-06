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

const REQUIRED_SHAPE_ERROR =
	"neoorm.config.ts must export defineConfig({ schema, out, datasource: { provider, url } })";

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

	it("loads multiple configs without re-registering tsx", async () => {
		const firstConfig = configSource(`{
    provider: "postgresql",
    url: "postgresql://postgres:postgres@localhost:5432/first",
  }`);
		const secondConfig = configSource(`{
    provider: "postgresql",
    url: "postgresql://postgres:postgres@localhost:5432/second",
  }`);

		await withConfigFile(firstConfig, async (firstDir) => {
			const first = await loadConfig(firstDir);
			expect(first.datasource.url).toBe(
				"postgresql://postgres:postgres@localhost:5432/first",
			);

			await withConfigFile(secondConfig, async (secondDir) => {
				const second = await loadConfig(secondDir);
				expect(second.datasource.url).toBe(
					"postgresql://postgres:postgres@localhost:5432/second",
				);
			});
		});
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
				await expect(loadConfig(dir)).rejects.toThrow(REQUIRED_SHAPE_ERROR);
			},
		);
	});

	it.each([
		["null export", "export default null;"],
		["no default or config export", "export const other = {};"],
		[
			"empty schema",
			configSource(`{
    provider: "postgresql",
    url: "postgresql://postgres:postgres@localhost:5432/app",
  }`).replace('schema: "./schema.ts"', 'schema: ""'),
		],
		[
			"non-string out",
			`
export default {
  schema: "./schema.ts",
  out: 123,
  datasource: {
    provider: "postgresql",
    url: "postgresql://postgres:postgres@localhost:5432/app",
  },
};
`,
		],
		[
			"missing datasource",
			`
export default {
  schema: "./schema.ts",
  out: "./neoorm",
};
`,
		],
		[
			"non-object datasource",
			`
export default {
  schema: "./schema.ts",
  out: "./neoorm",
  datasource: "postgresql",
};
`,
		],
		[
			"empty datasource url",
			configSource(`{
    provider: "postgresql",
    url: "",
  }`),
		],
	])("throws the required shape error for %s", async (_name, source) => {
		await withConfigFile(source, async (dir) => {
			await expect(loadConfig(dir)).rejects.toThrow(REQUIRED_SHAPE_ERROR);
		});
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
