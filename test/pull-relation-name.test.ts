import { describe, expect, it } from "vitest";
import type { Manifest, ManifestColumn } from "../src/dialect/types.js";
import { emitPostgresSchema } from "../src/introspect/pull.js";

function fkColumn(
	tsName: string,
	sqlName: string,
	fkAs: string,
): ManifestColumn {
	return {
		tsName,
		sqlName,
		kind: "fk",
		nullable: true,
		unique: false,
		primary: false,
		defaultNow: false,
		fkTarget: "users.id",
		fkAs,
	};
}

function usersItemsManifest(): Manifest {
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
						kind: "uuid",
						nullable: false,
						unique: true,
						primary: true,
						defaultNow: false,
					},
				],
				relations: [
					{
						name: "items",
						targetTable: "items",
						targetAccessor: "items",
						fkColumn: "statusChangedBy",
						fkSqlColumn: "status_changed_by",
						targetColumn: "id",
						cardinality: "many",
						inverse: "statusChangedBy",
					},
				],
				indexes: [],
				primaryKey: ["id"],
			},
			items: {
				accessor: "items",
				sqlName: "items",
				columns: [
					{
						tsName: "id",
						sqlName: "id",
						kind: "uuid",
						nullable: false,
						unique: true,
						primary: true,
						defaultNow: false,
					},
					// Id-less fk names: the inferred relation name would collide with
					// the column itself in generated query types
					fkColumn(
						"statusChangedBy",
						"status_changed_by",
						"statusChangedBy",
					),
					fkColumn("reviewedBy", "reviewed_by", "reviewedBy"),
					// conventional Id-suffixed fk: emitted without `.as()`
					fkColumn("ownerId", "owner_id", "owner"),
				],
				relations: [
					{
						name: "statusChangedBy",
						targetTable: "users",
						targetAccessor: "users",
						fkColumn: "statusChangedBy",
						fkSqlColumn: "status_changed_by",
						targetColumn: "id",
						cardinality: "one",
						inverse: "items",
					},
					{
						name: "reviewedBy",
						targetTable: "users",
						targetAccessor: "users",
						fkColumn: "reviewedBy",
						fkSqlColumn: "reviewed_by",
						targetColumn: "id",
						cardinality: "one",
						inverse: "items",
					},
					{
						name: "owner",
						targetTable: "users",
						targetAccessor: "users",
						fkColumn: "ownerId",
						fkSqlColumn: "owner_id",
						targetColumn: "id",
						cardinality: "one",
						inverse: "items",
					},
				],
				indexes: [],
				primaryKey: ["id"],
			},
		},
		manyToMany: [],
	};
}

describe("pulled fk relation names", () => {
	it("emits .as() with the singular target name when the fk name would collide", () => {
		const schema = emitPostgresSchema(usersItemsManifest());

		// the Id-less fk falls back to singularize("users") = "user"
		expect(schema).toContain('statusChangedBy: fk("users").as("user")');
		// the second colliding fk dedupes the fallback name
		expect(schema).toContain('reviewedBy: fk("users").as("user2")');
		// the conventional Id-suffixed fk keeps the inferred relation name
		expect(schema).toContain('ownerId: fk("users")');
		expect(schema).not.toContain('ownerId: fk("users").as(');
	});
});
