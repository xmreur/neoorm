import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		// Live Postgres suites share one database; run files one at a time when
		// DATABASE_URL is set so DROP SCHEMA / CREATE TABLE cannot race.
		fileParallelism: !process.env.DATABASE_URL,
	},
});
