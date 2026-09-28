import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURE = `import type { schema } from "../examples/blog/schema.js";
import type { WhereInput } from "../src/schema/types.js";
type Schema = typeof schema._tables;
type PostsWhere = WhereInput<Schema["posts"]["_columns"], Schema, "posts">;
declare function w(value: PostsWhere): void;
w({ price: { contains: "9" } });
w({ title: { gte: "x" } });
w({ titl: "x" });
`;

function tscOutput(configPath: string): string {
	try {
		execFileSync(
			"bunx",
			["tsc", "--noEmit", "--pretty", "false", "-p", configPath],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		return "";
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string };
		return `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
	}
}

describe("where type error messages", () => {
	it("names the filter instead of expanding anonymous operator bags", async () => {
		const dir = await mkdtemp(join(tmpdir(), "neoorm-where-errors-"));
		// Fixture lives in test/ so ../examples + ../src relative imports resolve.
		const projectDir = new URL("..", import.meta.url).pathname;
		const fixturePath = join(projectDir, "test", "__where-msg-fixture.ts");
		try {
			await writeFile(fixturePath, FIXTURE);
			const configPath = join(dir, "tsconfig.json");
			await writeFile(
				configPath,
				JSON.stringify({
					extends: join(projectDir, "tsconfig.json"),
					include: [fixturePath],
				}),
			);
			const output = tscOutput(configPath);
			const lines = output
				.split("\n")
				.filter((line) => line.includes("fixture.ts"));
			expect(lines.length).toBeGreaterThan(0);
			// Wrong operator points at the named filter …
			expect(output).toContain("ComparableFilter<string>");
			expect(output).toContain("StringFilter<string>");
			// … instead of dumping the anonymous operator bag …
			expect(output).not.toContain("InferColumnWhereOperators");
			expect(output).not.toContain("ComparableWhereOperators");
			// … while unknown keys keep their did-you-mean hint.
			expect(output).toContain("Did you mean to write");
			expect(output).toContain("titl");
		} finally {
			await rm(fixturePath, { force: true });
			await rm(dir, { recursive: true, force: true });
		}
	}, 120000);
});
