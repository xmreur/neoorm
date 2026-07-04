import { defineConfig } from "./dist/index.js";

export default defineConfig({
  schema: "./examples/blog/schema.ts",
  out: "./examples/blog/neoorm",
  datasource: {
    provider: "postgresql",
    url: process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/neoorm_test",
  },
});
