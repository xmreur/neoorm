import type { ColumnMeta } from "./column.js";

export type OnDeleteAction = "cascade" | "restrict" | "set null" | "no action";

export type FkMeta<
	TTarget extends string = string,
	TAs extends string = string,
	TInverse extends string = string,
	TUnique extends boolean = boolean,
> = ColumnMeta & {
	kind: "fk";
	target: TTarget;
	as: TAs;
	inverse: TInverse;
	onDelete?: OnDeleteAction;
	unique: TUnique;
};

export type FkBuilder<
	TTarget extends string = string,
	TAs extends string = string,
	TInverse extends string = string,
	TUnique extends boolean = boolean,
> = {
	readonly _type: string | null;
	readonly _meta: FkMeta<TTarget, TAs, TInverse, TUnique>;
	notNull(): FkBuilder<TTarget, TAs, TInverse, TUnique>;
	unique(): FkBuilder<TTarget, TAs, TInverse, true>;
	map(name: string): FkBuilder<TTarget, TAs, TInverse, TUnique>;
};

export type FkOptions<
	TAs extends string = string,
	TInverse extends string = string,
	TUnique extends boolean = boolean,
> = {
	as: TAs;
	inverse: TInverse;
	unique?: TUnique;
	nullable?: boolean;
	onDelete?: OnDeleteAction;
};

export function fk<
	const TTarget extends string,
	const TAs extends string,
	const TInverse extends string,
	const TUnique extends boolean = false,
>(
	target: TTarget,
	options: FkOptions<TAs, TInverse, TUnique>,
): FkBuilder<TTarget, TAs, TInverse, TUnique> {
	const meta: FkMeta<TTarget, TAs, TInverse, TUnique> = {
		kind: "fk",
		nullable: options.nullable !== false,
		unique: (options.unique ?? false) as TUnique,
		primary: false,
		defaultNow: false,
		target,
		as: options.as,
		inverse: options.inverse,
		...(options.onDelete !== undefined
			? { onDelete: options.onDelete }
			: {}),
	};

	function withMeta<TU extends boolean = TUnique>(
		next: FkMeta<TTarget, TAs, TInverse, TU>,
	): FkBuilder<TTarget, TAs, TInverse, TU> {
		return {
			_type: null as string | null,
			_meta: next,
			notNull(): FkBuilder<TTarget, TAs, TInverse, TU> {
				return withMeta({ ...next, nullable: false } as FkMeta<TTarget, TAs, TInverse, TU>);
			},
			unique(): FkBuilder<TTarget, TAs, TInverse, true> {
				return withMeta<true>({ ...next, unique: true } as FkMeta<TTarget, TAs, TInverse, true>);
			},
			map(name: string): FkBuilder<TTarget, TAs, TInverse, TU> {
				return withMeta({ ...next, mapName: name } as FkMeta<TTarget, TAs, TInverse, TU>);
			},
		};
	}

	return withMeta(meta);
}
