import type { TableDef } from "./table.js";

export type ManyToManyDef = {
	kind: "manyToMany";
	leftKey: string;
	rightKey: string;
	throughKey: string;
	leftRelation: string;
	rightRelation: string;
	as: string;
	inverse: string;
};

// The registry lives on globalThis so every module instance (src vs dist,
// tsx tsImport vs Node import) shares the same array — a schema module loaded
// through tsImport evaluates its DSL imports in an isolated module graph, so a
// module-local array would never be visible to the codegen process reading it.
const REGISTRY_KEY = Symbol.for("neoorm.manyToManyRegistry");

function registry(): ManyToManyDef[] {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return ((globalThis as any)[REGISTRY_KEY] ??= []);
}

export function manyToMany<
	TLeft extends TableDef,
	TRight extends TableDef,
	TThrough extends TableDef,
>(
	left: TLeft,
	right: TRight,
	options: {
		through: TThrough;
		left: string;
		right: string;
		as: string;
		inverse: string;
	},
): void {
	registry().push({
		kind: "manyToMany",
		leftKey: left._tableName,
		rightKey: right._tableName,
		throughKey: options.through._tableName,
		leftRelation: options.left,
		rightRelation: options.right,
		as: options.as,
		inverse: options.inverse,
	});
}

export function getManyToManyRegistry(): readonly ManyToManyDef[] {
	return registry();
}

export function clearManyToManyRegistry(): void {
	registry().length = 0;
}
