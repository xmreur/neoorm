/** Virtual many-to-many relation column (not a physical table column). */
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

/** Options for {@link many}. */
export type InlineManyToManyOptions = {
	/** Junction table accessor. When omitted, a junction table is generated. */
	through?: string;
	/** Junction column (TS name) referencing the source table. */
	leftKey?: string;
	/** Junction column (TS name) referencing the target table. */
	rightKey?: string;
	/** Relation name on the source table. Defaults to the column key. */
	as?: string;
	/** Relation name on the target table. Defaults to the source accessor. */
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

/**
 * Declare a many-to-many relation as a virtual column on the source table.
 *
 * @param target - Target table accessor (e.g. `"tags"`).
 * @param options - Optional junction table accessor and key overrides.
 *
 * @example
 * ```ts
 * posts: table({
 *   tags: many("tags"),
 * }),
 * ```
 */
export function many<
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

/** @deprecated Use `many()` instead. */
export const manyToMany = many;
