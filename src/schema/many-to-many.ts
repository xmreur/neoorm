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

const manyToManyRegistry: ManyToManyDef[] = [];

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
	manyToManyRegistry.push({
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
	return manyToManyRegistry;
}

export function clearManyToManyRegistry(): void {
	manyToManyRegistry.length = 0;
}
