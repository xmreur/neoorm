import { describe, expect, it } from "vitest";
import type { Manifest, ManifestColumn } from "../src/dialect/types.js";
import {
	emitPostgresSchema,
	emitSqliteSchema,
} from "../src/introspect/pull.js";

function idCol(): ManifestColumn {
	return {
		tsName: "id",
		sqlName: "id",
		kind: "uuid",
		nullable: false,
		unique: true,
		primary: true,
		defaultNow: false,
	};
}

function fkCol(tsName: string, sqlName: string, fkAs: string): ManifestColumn {
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

const fkColumn = fkCol;

function textCol(tsName: string, sqlName: string): ManifestColumn {
	return {
		tsName,
		sqlName,
		kind: "text",
		nullable: true,
		unique: false,
		primary: false,
		defaultNow: false,
	};
}

function oneRel(
	name: string,
	fkColumn: string,
	cardinality: "one" | "many",
	inverse: string,
): Manifest["tables"][string]["relations"][number] {
	return {
		name,
		targetTable: "users",
		targetAccessor: "users",
		fkColumn,
		fkSqlColumn: fkColumn,
		targetColumn: "id",
		cardinality,
		inverse,
	};
}

function mkTable(
	accessor: string,
	columns: ManifestColumn[],
	extra: Partial<Manifest["tables"][string]> = {},
): Manifest["tables"][string] {
	return {
		accessor,
		sqlName: accessor,
		columns,
		relations: extra.relations ?? [],
		indexes: extra.indexes ?? [],
		primaryKey: ["id"],
		foreignKeys: extra.foreignKeys ?? [],
	};
}

function usersManifest(): Manifest {
	return {
		version: 1,
		tables: {
			users: mkTable("users", [idCol(), textCol("name", "name")], {
				foreignKeys: [],
			}),
			items: mkTable(
				"items",
				[
					idCol(),
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
				{
					relations: [
						oneRel(
							"statusChangedBy",
							"statusChangedBy",
							"one",
							"items",
						),
						oneRel("reviewedBy", "reviewedBy", "one", "items"),
						oneRel("owner", "ownerId", "one", "items"),
					],
					foreignKeys: [],
				},
			),
		},
		manyToMany: [],
	};
}

const usersItemsManifest = usersManifest;

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

	it("resolves an fk name colliding with a different scalar column", () => {
		const manifest: Manifest = {
			version: 1,
			tables: {
				users: mkTable("users", [idCol()]),
				items: mkTable(
					"items",
					[
						idCol(),
						textCol("statusChangedBy", "status_changed_by"),
						fkCol(
							"statusChangedById",
							"status_changed_by_id",
							"statusChangedBy",
						),
					],
					{ foreignKeys: [] },
				),
			},
			manyToMany: [],
		};
		const schema = emitPostgresSchema(manifest);

		// "statusChangedBy" itself is taken by the scalar column
		expect(schema).toContain(
			'statusChangedById: fk("users").as("statusChangedBy2")',
		);
	});

	it("suffixes beyond the first collision", () => {
		const manifest: Manifest = {
			version: 1,
			tables: {
				users: mkTable("users", [idCol()]),
				items: mkTable(
					"items",
					[
						idCol(),
						textCol("statusChangedBy", "status_changed_by"),
						textCol("statusChangedBy2", "status_changed_by_2"),
						textCol("statusChangedBy3", "status_changed_by_3"),
						fkCol(
							"statusChangedById",
							"status_changed_by_id",
							"statusChangedBy",
						),
					],
					{ foreignKeys: [] },
				),
			},
			manyToMany: [],
		};
		const schema = emitPostgresSchema(manifest);

		expect(schema).toContain(
			'statusChangedById: fk("users").as("statusChangedBy4")',
		);
	});

	it("keeps inferring-fk names distinct from a sibling fk column's own fallback", () => {
		const manifest: Manifest = {
			version: 1,
			tables: {
				users: mkTable("users", [idCol()]),
				items: mkTable(
					"items",
					[
						idCol(),
						// self-colliding fk: inferred name equals its own column
						fkCol("user", "user", "user"),
						// conventional fk whose inferred name "user" collides with the
						// sibling column above
						fkCol("userId", "user_id", "user"),
					],
					{ foreignKeys: [] },
				),
			},
			manyToMany: [],
		};
		const schema = emitPostgresSchema(manifest);

		expect(schema).toContain('user: fk("users").as("user2")');
		expect(schema).toContain('userId: fk("users").as("user3")');
	});

	it("emits an explicit inverse when the default inverse name is taken on the target", () => {
		const manifest: Manifest = {
			version: 1,
			tables: {
				users: mkTable("users", [idCol(), textCol("items", "items")]),
				items: mkTable(
					"items",
					[idCol(), fkCol("ownerId", "owner_id", "owner")],
					{
						foreignKeys: [],
						relations: [oneRel("owner", "ownerId", "one", "users")],
					},
				),
			},
			manyToMany: [],
		};
		const schema = emitPostgresSchema(manifest);

		// the default inverse "items" is a users column — suffixed instead
		expect(schema).toContain('ownerId: fk("users").inverse("items2")');
	});

	it("emits an explicit inverse for a second fk to the same target", () => {
		const manifest: Manifest = {
			version: 1,
			tables: {
				users: mkTable("users", [idCol()]),
				payments: mkTable(
					"payments",
					[
						idCol(),
						fkCol("fromId", "from_id", "from"),
						fkCol("toId", "to_id", "to"),
					],
					{
						foreignKeys: [],
						relations: [
							oneRel("from", "fromId", "one", "payments"),
							oneRel("to", "toId", "one", "payments"),
						],
					},
				),
			},
			manyToMany: [],
		};
		const schema = emitPostgresSchema(manifest);

		// the first fk keeps the implicit default inverse; the second fk's
		// inverse "payments" is already reserved on users → explicit suffix
		expect(schema).toContain('fromId: fk("users")');
		expect(schema).toContain('toId: fk("users").inverse("payments2")');
	});

	it("suffixes an explicit alias that collides with a scalar column", () => {
		const manifest: Manifest = {
			version: 1,
			tables: {
				users: mkTable("users", [idCol()]),
				items: mkTable(
					"items",
					[
						idCol(),
						textCol("user", "user"),
						fkCol("userId", "user_id", "user"),
					],
					{ foreignKeys: [] },
				),
			},
			manyToMany: [],
		};
		const schema = emitPostgresSchema(manifest);

		expect(schema).toContain('userId: fk("users").as("user2")');
	});

	it("avoids collisions in composite fk extras", () => {
		const manifest: Manifest = {
			version: 1,
			tables: {
				brands: mkTable(
					"brands",
					[idCol(), textCol("name", "name"), textCol("sku", "sku")],
					{
						indexes: [
							{
								name: "brands_name_sku_unique",
								columns: ["name", "sku"],
								unique: true,
							},
						],
					},
				),
				items: mkTable(
					"items",
					[
						idCol(),
						textCol("user", "user"),
						textCol("userId", "user_id"),
						textCol("brandId", "brand_id"),
					],
					{
						foreignKeys: [
							{
								name: "items_user_brand_fkey",
								columns: ["user_id", "brand_id"],
								targetTable: "brands",
								targetColumns: ["name", "sku"],
							},
						],
						relations: [],
					},
				),
			},
			manyToMany: [],
		};
		const schema = emitPostgresSchema(manifest);

		// inferFkAs("userId") = "user" — taken by the scalar column → "user2"
		expect(schema).toContain(
			'foreignKey(t.userId, t.brandId).references("brands", "name", "sku")',
		);
		expect(schema).toContain('.as("user2")');
		expect(schema).toMatch(/as\("user2"\)\.inverse\("items"\)/);
	});

	it("suffixes the inverse for a second composite fk to the same target", () => {
		const manifest: Manifest = {
			version: 1,
			tables: {
				brands: mkTable(
					"brands",
					[idCol(), textCol("name", "name"), textCol("sku", "sku")],
					{
						indexes: [
							{
								name: "brands_name_sku_unique",
								columns: ["name", "sku"],
								unique: true,
							},
						],
					},
				),
				items: mkTable(
					"items",
					[
						idCol(),
						textCol("userId", "user_id"),
						textCol("brandId", "brand_id"),
						textCol("creatorId", "creator_id"),
						textCol("verifierId", "verifier_id"),
					],
					{
						foreignKeys: [
							{
								name: "items_user_brand_fkey",
								columns: ["user_id", "brand_id"],
								targetTable: "brands",
								targetColumns: ["name", "sku"],
							},
							{
								name: "items_creator_verifier_fkey",
								columns: ["creator_id", "verifier_id"],
								targetTable: "brands",
								targetColumns: ["name", "sku"],
							},
						],
						relations: [],
					},
				),
			},
			manyToMany: [],
		};
		const schema = emitPostgresSchema(manifest);

		expect(schema).toContain('.as("user").inverse("items")');
		expect(schema).toMatch(/as\("creator"\)\.inverse\("items2"\)/);
	});

	it("applies identical naming to the sqlite emitter", () => {
		const schema = emitSqliteSchema(usersItemsManifest());

		expect(schema).toContain('statusChangedBy: fk("users").as("user")');
		expect(schema).toContain('reviewedBy: fk("users").as("user2")');
		expect(schema).toContain('ownerId: fk("users")');
	});

	it("suggests an explicit inverse from another fk emitting the same default", () => {
		// two fks into the same target where the second's default inverse is a
		// column on the target — combined collision
		const manifest: Manifest = {
			version: 1,
			tables: {
				users: mkTable("users", [
					idCol(),
					textCol("payments", "payments"),
				]),
				payments: mkTable(
					"payments",
					[
						idCol(),
						fkCol("fromId", "from_id", "from"),
						fkCol("toId", "to_id", "to"),
					],
					{ foreignKeys: [] },
				),
			},
			manyToMany: [],
		};
		const schema = emitPostgresSchema(manifest);

		// "payments" (default inverse) is taken by the users column "payments",
		// the second fk must then skip "payments2"
		expect(schema).toContain('fromId: fk("users").inverse("payments2")');
		expect(schema).toContain('toId: fk("users").inverse("payments3")');
	});

	it("produces deterministic output across repeated emissions", () => {
		const first = emitPostgresSchema(usersItemsManifest());
		const second = emitPostgresSchema(usersItemsManifest());
		const sqliteFirst = emitSqliteSchema(usersItemsManifest());
		const sqliteSecond = emitSqliteSchema(usersItemsManifest());

		expect(first).toBe(second);
		expect(sqliteFirst).toBe(sqliteSecond);
	});
});
