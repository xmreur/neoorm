import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("..", import.meta.url).pathname;
const distSchemaTypes = join(repoRoot, "dist/schema/index.d.ts");

/** Mirrors a Nest consumer that emits .d.ts for a root `schema.ts`. */
const CONSUMER_SCHEMA = `import {
	defineSchema,
	fk,
	id,
	many,
	table,
	text,
	timestamps,
} from "neoorm/schema";

export const schema = defineSchema({
	users: table({
		id: id(),
		email: text().notNull().unique(),
		...timestamps(),
	}),
	posts: table({
		id: id(),
		authorId: fk("users").notNull().index(),
		title: text().notNull(),
		...timestamps(),
		tags: many("tags"),
	}),
	tags: table({
		id: id(),
		name: text().notNull(),
	}),
});
`;

describe.skipIf(!existsSync(distSchemaTypes))(
	"schema declaration emit for consumers",
	() => {
		it("emits schema.d.ts without reaching into neoorm/dist/schema/table", async () => {
			const dir = await mkdtemp(
				join(tmpdir(), "neoorm-schema-declaration-"),
			);
			try {
				await writeFile(join(dir, "schema.ts"), CONSUMER_SCHEMA);
				await writeFile(
					join(dir, "tsconfig.json"),
					JSON.stringify({
						compilerOptions: {
							module: "es2022",
							moduleResolution: "bundler",
							resolvePackageJsonExports: true,
							isolatedModules: true,
							declaration: true,
							emitDeclarationOnly: true,
							outDir: "./out",
							target: "ES2023",
							strict: true,
							skipLibCheck: true,
						},
						include: ["schema.ts"],
					}),
				);
				await mkdir(join(dir, "node_modules"));
				await symlink(repoRoot, join(dir, "node_modules", "neoorm"));

				const require = createRequire(import.meta.url);
				const tscBin = join(
					dirname(require.resolve("typescript/package.json")),
					"bin",
					"tsc",
				);
				let output = "";
				try {
					output = execFileSync(
						process.execPath,
						[tscBin, "-p", join(dir, "tsconfig.json")],
						{ encoding: "utf-8", stdio: "pipe", timeout: 120000 },
					);
				} catch (error) {
					const failed = error as {
						stdout?: unknown;
						stderr?: unknown;
						message?: string;
					};
					const detail = [
						failed.stdout,
						failed.stderr,
						failed.message,
					]
						.filter(
							(part) =>
								typeof part === "string" && part.length > 0,
						)
						.join("\n");
					expect(
						detail,
						"consumer schema.ts should emit declarations",
					).toBe("");
					return;
				}
				expect(output).toBe("");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}, 120000);
	},
);
