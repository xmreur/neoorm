import { describe, it, expect } from "vitest";
import type { Manifest, ManifestDiff } from "../src/dialect/types.js";
import { diffManifest } from "../src/codegen/diff-manifest.js";
import {
  summarizeGenerateOutcome,
  formatGenerateSummary,
} from "../src/codegen/generate-summary.js";

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    tables: {
      users: {
        accessor: "users",
        sqlName: "users",
        columns: [
          {
            tsName: "id",
            sqlName: "id",
            kind: "id",
            nullable: false,
            unique: false,
            primary: true,
            defaultNow: false,
          },
        ],
        relations: [],
        indexes: [],
        primaryKey: ["id"],
      },
    },
    manyToMany: [],
    ...overrides,
  };
}

describe("summarizeGenerateOutcome", () => {
  it("classifies unchanged schema", () => {
    const manifest = baseManifest();
    const diff = diffManifest(manifest, manifest);
    const summary = summarizeGenerateOutcome({
      prev: manifest,
      next: manifest,
      diff,
      sql: [],
      blocked: [],
      schemaChanged: false,
      migrationName: null,
    });
    expect(summary.status).toBe("unchanged");
    expect(summary.reasons[0]).toContain("Snapshot matches schema");
  });

  it("classifies migration created", () => {
    const prev = baseManifest();
    const next = baseManifest({
      tables: {
        users: prev.tables.users!,
        posts: {
          accessor: "posts",
          sqlName: "posts",
          columns: [
            {
              tsName: "id",
              sqlName: "id",
              kind: "id",
              nullable: false,
              unique: false,
              primary: true,
              defaultNow: false,
            },
          ],
          relations: [],
          indexes: [],
          primaryKey: ["id"],
        },
      },
    });
    const diff = diffManifest(prev, next);
    const summary = summarizeGenerateOutcome({
      prev,
      next,
      diff,
      sql: diff.sql,
      blocked: [],
      schemaChanged: true,
      migrationName: "20250101_migration",
    });
    expect(summary.status).toBe("migration_created");
    expect(summary.sqlStatementCount).toBeGreaterThan(0);
  });

  it("classifies blocked migration", () => {
    const prev = baseManifest({
      tables: {
        users: {
          accessor: "users",
          sqlName: "users",
          columns: [
            {
              tsName: "id",
              sqlName: "id",
              kind: "id",
              nullable: false,
              unique: false,
              primary: true,
              defaultNow: false,
            },
            {
              tsName: "legacy",
              sqlName: "legacy",
              kind: "text",
              nullable: true,
              unique: false,
              primary: false,
              defaultNow: false,
            },
          ],
          relations: [],
          indexes: [],
          primaryKey: ["id"],
        },
      },
    });
    const next = baseManifest();
    const diff = diffManifest(prev, next);
    const summary = summarizeGenerateOutcome({
      prev,
      next,
      diff,
      sql: [],
      blocked: diff.destructive,
      schemaChanged: true,
      migrationName: null,
    });
    expect(summary.status).toBe("migration_blocked");
    expect(summary.reasons.some((r) => r.includes("Re-run:"))).toBe(true);
  });

  it("classifies codegen-only changes", () => {
    const prev = baseManifest({ enumMode: "check" });
    const next = baseManifest({ enumMode: "native" });
    const diff: ManifestDiff = { isInitial: false, sql: [], destructive: [] };
    const summary = summarizeGenerateOutcome({
      prev,
      next,
      diff,
      sql: [],
      blocked: [],
      schemaChanged: true,
      migrationName: null,
    });
    expect(summary.status).toBe("codegen_only");
    expect(summary.reasons.some((r) => r.includes("enumMode"))).toBe(true);
  });
});

describe("formatGenerateSummary", () => {
  it("formats blocked output with actionable footer", () => {
    const lines = formatGenerateSummary(
      {
        status: "migration_blocked",
        schemaChanged: true,
        migrationName: null,
        sqlStatementCount: 0,
        reasons: ["Drop column example", "Re-run: neoorm generate --accept-data-loss"],
        blocked: [],
      },
      "/tmp/out",
    );
    expect(lines[0]).toContain("No migration written");
    expect(lines.some((line) => line.includes("Re-run:"))).toBe(true);
  });
});
