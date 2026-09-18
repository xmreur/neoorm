import { describe, expect, it } from "vitest";
import {
	assertInitAnswers,
	validateDatabaseUrl,
	validateOutDir,
	validateSchemaPath,
} from "../src/init/validate.js";

describe("init validators", () => {
	it("accepts TypeScript schema paths", () => {
		expect(validateSchemaPath("./schema.ts")).toBeUndefined();
		expect(validateSchemaPath("db/schema.mts")).toBeUndefined();
		expect(validateSchemaPath("schema.cts")).toBeUndefined();
	});

	it("rejects empty or non-TypeScript schema paths", () => {
		expect(validateSchemaPath("")).toBe("Schema path is required");
		expect(validateSchemaPath("   ")).toBe("Schema path is required");
		expect(validateSchemaPath("schema.js")).toBe(
			"Schema path must end in .ts, .mts, or .cts",
		);
		expect(validateSchemaPath("schema")).toBe(
			"Schema path must end in .ts, .mts, or .cts",
		);
	});

	it("rejects an empty out dir or a path that collides with the schema file", () => {
		expect(validateOutDir("", "./schema.ts", "/tmp/app")).toBe(
			"Output directory is required",
		);
		expect(validateOutDir("./schema.ts", "./schema.ts", "/tmp/app")).toBe(
			"Output directory cannot be the same path as the schema file",
		);
		expect(
			validateOutDir("./neoorm", "./schema.ts", "/tmp/app"),
		).toBeUndefined();
	});

	it("requires a URL scheme for server databases and allows sqlite file paths", () => {
		expect(validateDatabaseUrl("", "postgresql")).toBe(
			"Database URL is required",
		);
		expect(validateDatabaseUrl("localhost:5432/app", "postgresql")).toBe(
			"Database URL must include a scheme (e.g. postgresql://...)",
		);
		expect(
			validateDatabaseUrl(
				"postgresql://postgres:postgres@localhost:5432/myapp",
				"postgresql",
			),
		).toBeUndefined();
		expect(validateDatabaseUrl("./dev.db", "sqlite")).toBeUndefined();
		expect(validateDatabaseUrl("file:./dev.db", "sqlite")).toBeUndefined();
		expect(
			validateDatabaseUrl("mysql://root@localhost:3306/myapp", "mysql"),
		).toBeUndefined();
		expect(validateDatabaseUrl("root@localhost", "mariadb")).toBe(
			"Database URL must include a scheme (e.g. postgresql://...)",
		);
	});

	it("throws from assertInitAnswers when any field is invalid", () => {
		expect(() =>
			assertInitAnswers({
				cwd: "/tmp/app",
				provider: "postgresql",
				schemaPath: "schema.js",
				outDir: "./neoorm",
				databaseUrl: "postgresql://localhost/db",
			}),
		).toThrow(/Schema path must end/);
	});
});
