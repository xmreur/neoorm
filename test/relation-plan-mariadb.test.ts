import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import {
	findOneRelationPlanOptions,
	planRelationLoad,
} from "../src/runtime/query/relation-planner.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { manifestTable } from "./helpers/manifest.js";

describe("MariaDB relation load plan", () => {
	const manifest = schemaToManifest(schema);
	const users = manifestTable(manifest, "users");
	const tableIndex = buildManifestIndex(manifest, mariadbDialect);

	it("batches has-many when correlated json agg would be required", () => {
		const plan = planRelationLoad(
			manifest,
			users,
			{ posts: true },
			mariadbDialect,
			tableIndex,
			{ useHasManyAggregate: false },
		);

		expect(plan.batchWith.posts).toBe(true);
		expect(plan.inlineJsonAgg).toEqual([]);
		expect(plan.hasManyAggregate).toBeUndefined();
	});

	it("batches nested to-many includes", () => {
		const plan = planRelationLoad(
			manifest,
			users,
			{ posts: { with: { comments: true } } },
			mariadbDialect,
			tableIndex,
			{ useHasManyAggregate: false },
		);

		expect(plan.batchWith.posts).toEqual({ with: { comments: true } });
		expect(plan.inlineJsonAgg).toEqual([]);
	});

	it("keeps JOIN aggregate for simple findMany has-many", () => {
		const plan = planRelationLoad(
			manifest,
			users,
			{ posts: true },
			mariadbDialect,
			tableIndex,
			{ useHasManyAggregate: true },
		);

		expect(plan.hasManyAggregate).toBeDefined();
		expect(plan.batchWith.posts).toBeUndefined();
		expect(plan.inlineJsonAgg.map((item) => item.relationName)).toEqual([
			"posts",
		]);
	});

	it("prefers JOIN aggregate for MariaDB findById / findFirst", () => {
		expect(findOneRelationPlanOptions(mariadbDialect)).toEqual({
			useHasManyAggregate: true,
		});
		expect(findOneRelationPlanOptions(mysqlDialect)).toEqual({
			useHasManyAggregate: false,
		});

		const plan = planRelationLoad(
			manifest,
			users,
			{ posts: true },
			mariadbDialect,
			tableIndex,
			findOneRelationPlanOptions(mariadbDialect),
		);
		expect(plan.hasManyAggregate).toBeDefined();
		expect(plan.batchWith.posts).toBeUndefined();
	});

	it("batches nested take, where, orderBy, and with even when JOIN agg is preferred", () => {
		for (const withSpec of [
			{ posts: { take: 3 } },
			{ posts: { where: { title: "x" } } },
			{ posts: { orderBy: { title: "asc" as const } } },
			{ posts: { with: { comments: true } } },
		]) {
			const plan = planRelationLoad(
				manifest,
				users,
				withSpec,
				mariadbDialect,
				tableIndex,
				{ useHasManyAggregate: true },
			);
			expect(plan.hasManyAggregate).toBeUndefined();
			expect(plan.batchWith.posts).toEqual(withSpec.posts);
		}
	});

	it("still uses correlated json agg on mysql", () => {
		const plan = planRelationLoad(
			manifest,
			users,
			{ posts: true },
			mysqlDialect,
			buildManifestIndex(manifest, mysqlDialect),
			{ useHasManyAggregate: false },
		);

		expect(plan.batchWith.posts).toBeUndefined();
		expect(plan.inlineJsonAgg.map((item) => item.relationName)).toEqual([
			"posts",
		]);
	});
});
