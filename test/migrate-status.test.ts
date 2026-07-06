import { describe, expect, it } from "vitest";
import {
	computeMigrationStatus,
	formatMigrateStatus,
} from "../src/migrate/runner.js";

describe("computeMigrationStatus", () => {
	it("lists pending migrations not yet applied", () => {
		const status = computeMigrationStatus(
			["20250101_init", "20250102_add_posts"],
			[
				{
					name: "20250101_init",
					appliedAt: new Date("2025-01-01T12:00:00Z"),
				},
			],
		);
		expect(status.pending).toEqual(["20250102_add_posts"]);
		expect(status.applied).toHaveLength(1);
		expect(status.orphanApplied).toEqual([]);
	});

	it("detects applied migrations missing on disk", () => {
		const status = computeMigrationStatus(
			["20250101_init"],
			[
				{
					name: "20250101_init",
					appliedAt: new Date("2025-01-01T12:00:00Z"),
				},
				{
					name: "20241201_old",
					appliedAt: new Date("2024-12-01T12:00:00Z"),
				},
			],
		);
		expect(status.orphanApplied).toEqual(["20241201_old"]);
	});
});

describe("formatMigrateStatus", () => {
	it("renders applied and pending sections", () => {
		const lines = formatMigrateStatus(
			{
				applied: [
					{
						name: "20250101_init",
						appliedAt: new Date("2025-01-01T12:00:00.000Z"),
					},
				],
				pending: ["20250102_add_posts"],
				orphanApplied: [],
			},
			"/project/neoorm/migrations",
		);
		expect(lines.join("\n")).toContain(
			"Migration status (/project/neoorm/migrations)",
		);
		expect(lines.join("\n")).toContain("✓ 20250101_init");
		expect(lines.join("\n")).toContain("○ 20250102_add_posts");
		expect(lines.join("\n")).toContain("Summary: 1 applied, 1 pending");
	});
});
