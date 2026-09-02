import type { TableDef } from "./table.js";

export type ManyToManyExtra<
	TTarget extends string = string,
	TAs extends string = string,
	TInverse extends string = string,
> = {
	kind: "manyToMany";
	/** Target table accessor name (e.g. "tags"). */
	target: TTarget;
	/** Junction table SQL name. When omitted, a junction table is generated. */
	through?: string;
	/** Junction column (TS name) referencing the source table. */
	leftKey?: string;
	/** Junction column (TS name) referencing the target table. */
	rightKey?: string;
	/** Relation name on the source table. Defaults to the column/extras key. */
	as: TAs;
	/** Relation name on the target table. Defaults to the source accessor. */
	inverse: TInverse;
};

export type InlineManyToManyOptions = {
	through?: string;
	leftKey?: string;
	rightKey?: string;
	as?: string;
	inverse?: string;
};

type ManyToManyAsOf<T extends InlineManyToManyOptions> = T extends {
	as: infer As extends string;
}
	? As
	: "";

type ManyToManyInverseOf<T extends InlineManyToManyOptions> = T extends {
	inverse: infer Inv extends string;
}
	? Inv
	: "";

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
	const TTarget extends string,
	const TOptions extends InlineManyToManyOptions = {},
>(
	target: TTarget,
	options?: TOptions,
): ManyToManyExtra<
	TTarget,
	ManyToManyAsOf<TOptions>,
	ManyToManyInverseOf<TOptions>
>;
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
): void;
export function manyToMany(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	...args: any[]
): ManyToManyExtra | void {
	const [first, second, third] = args;
	if (typeof first === "string") {
		const options = second as InlineManyToManyOptions | undefined;
		return {
			kind: "manyToMany",
			target: first,
			...(options?.through ? { through: options.through } : {}),
			...(options?.leftKey ? { leftKey: options.leftKey } : {}),
			...(options?.rightKey ? { rightKey: options.rightKey } : {}),
			as: options?.as ?? "",
			inverse: options?.inverse ?? "",
		};
	}

	const left = first;
	const right = second;
	const options = third as {
		through: TableDef;
		left: string;
		right: string;
		as: string;
		inverse: string;
	};
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