import type { ValidationField, ValidationType } from "./types.js";

type InferObjectFields<TFields extends readonly ValidationField[]> = {
	[Field in TFields[number] as Field["name"]]: Field["optional"] extends true
		? InferValidationType<Field["type"]> | undefined
		: Field["nullable"] extends true
			? InferValidationType<Field["type"]> | null
			: InferValidationType<Field["type"]>;
};

type InferTupleElements<TElements extends readonly ValidationType[]> = {
	[K in keyof TElements]: TElements[K] extends ValidationType
		? InferValidationType<TElements[K]>
		: never;
};

/** Map validation IR nodes to TypeScript value types (for `jsonb().schema(...)`). */
export type InferValidationType<T extends ValidationType> = T extends {
	kind: "string";
}
	? string
	: T extends { kind: "number" }
		? number
		: T extends { kind: "bigint" }
			? bigint
			: T extends { kind: "boolean" }
				? boolean
				: T extends { kind: "date" }
					? Date
					: T extends {
								kind: "enum";
								values: readonly [string, ...string[]];
							}
						? T["values"][number]
						: T extends { kind: "unknown" }
							? unknown
							: T extends {
										kind: "array";
										element: infer E extends ValidationType;
									}
								? InferValidationType<E>[]
								: T extends {
											kind: "object";
											fields: infer F extends
												readonly ValidationField[];
										}
									? InferObjectFields<F>
									: T extends {
												kind: "record";
												value: infer V extends
													ValidationType;
											}
										? Record<string, InferValidationType<V>>
										: T extends {
													kind: "union";
													variants: infer V extends
														readonly ValidationType[];
												}
											? InferValidationType<V[number]>
											: T extends {
														kind: "literal";
														value: infer V extends
															| string
															| number
															| boolean;
													}
												? V
												: T extends {
															kind: "tuple";
															elements: infer E extends
																readonly ValidationType[];
														}
													? InferTupleElements<E>
													: T extends {
																kind: "instance";
																tsName: "Buffer";
															}
														? Buffer
														: never;
