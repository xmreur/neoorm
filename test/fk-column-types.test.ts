import { describe, expect, expectTypeOf, it } from "vitest";
import { emitModelsTs } from "../src/codegen/emit-models.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import {
	defineSchema,
	fk,
	serial,
	table,
	uuid,
} from "../src/schema/index.js";
import type { CreateInput, InferSelectRow } from "../src/schema/types.js";

const schema = defineSchema({
	items: table("items", {
		id: serial().primary(),
	}),
	users: table("users", {
		id: uuid().primary(),
	}),
	orders: table("orders", {
		id: serial().primary(),
		itemId: fk("items.id").notNull(),
		optionalItemId: fk("items.id"),
		userId: fk("users.id").notNull(),
	}),
});

type Tables = typeof schema._tables;
type OrderCreate = CreateInput<Tables["orders"]["_columns"], Tables, "orders">;
type OrderRow = InferSelectRow<Tables["orders"]["_columns"], Tables>;

describe("foreign key TypeScript types", () => {
	it("emits the referenced PK type in generated models", () => {
		const models = emitModelsTs(schemaToManifest(schema));
		const order = models.match(/export type Order = \{[\s\S]*?\n\};/)?.[0];
		expect(order).toContain("itemId: number;");
		expect(order).toContain("optionalItemId: number | null;");
		expect(order).toContain("userId: string;");
		expect(order).not.toContain("itemId: string");
	});

	it("accepts a number for an integer FK on create", () => {
		expectTypeOf<NonNullable<OrderCreate["itemId"]>>().toEqualTypeOf<number>();
		expectTypeOf<NonNullable<OrderCreate["userId"]>>().toEqualTypeOf<string>();
		expectTypeOf<NonNullable<OrderRow["itemId"]>>().toEqualTypeOf<number>();
		expectTypeOf<NonNullable<OrderRow["userId"]>>().toEqualTypeOf<string>();
		expectTypeOf<OrderRow["optionalItemId"]>().toEqualTypeOf<number | null>();

		const data: OrderCreate = { itemId: 1, userId: "u" };
		void data;
	});
});
