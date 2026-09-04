export type ManyToManyExtra<
	TTarget extends string = string,
	TAs extends string = string,
	TInverse extends string = string,
> = {
	kind: "manyToMany";
	/** Target table accessor name (e.g. "tags"). */
	target: TTarget;
	/** Junction table accessor. When omitted, a junction table is generated. */
	through?: string;
	/** Junction column (TS name) referencing the source table. */
	leftKey?: string;
	/** Junction column (TS name) referencing the target table. */
	rightKey?: string;
	/** Relation name on the source table. Defaults to the column key. */
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
> {
	return {
		kind: "manyToMany",
		target,
		...(options?.through ? { through: options.through } : {}),
		...(options?.leftKey ? { leftKey: options.leftKey } : {}),
		...(options?.rightKey ? { rightKey: options.rightKey } : {}),
		as: (options?.as ?? "") as ManyToManyAsOf<TOptions>,
		inverse: (options?.inverse ?? "") as ManyToManyInverseOf<TOptions>,
	};
}
