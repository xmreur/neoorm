/**
 * Library-agnostic validation IR. Emitters (Zod today; Valibot/ArkType later)
 * print this structure — they must not inspect ManifestColumn kinds.
 */

export type ValidationType =
	| { kind: "string"; format?: "uuid" | "email" | "url" }
	| { kind: "number"; int?: boolean }
	| { kind: "bigint" }
	| { kind: "boolean" }
	| { kind: "date" }
	| {
			kind: "enum";
			values: readonly [string, ...string[]];
			name?: string;
	  }
	| { kind: "unknown" }
	| {
			kind: "record";
			key?: ValidationType;
			value: ValidationType;
	  }
	| { kind: "array"; element: ValidationType }
	| { kind: "object"; fields: ValidationField[] }
	| { kind: "union"; variants: ValidationType[] }
	| { kind: "literal"; value: string | number | boolean }
	| { kind: "tuple"; elements: ValidationType[] }
	| { kind: "instance"; tsName: "Buffer" };

export type ValidationConstraints = {
	minLength?: number;
	maxLength?: number;
	min?: number | string;
	max?: number | string;
	positive?: boolean;
};

export type ValidationField = {
	name: string;
	type: ValidationType;
	nullable: boolean;
	optional: boolean;
	constraints?: ValidationConstraints;
};

export type ValidationEnum = {
	name: string;
	values: readonly [string, ...string[]];
};

/** M2M through-table metadata for codegen (nested writes live on the parent). */
export type JunctionValidation = {
	leftAccessor: string;
	rightAccessor: string;
	relationAs: string;
	inverseAs: string;
	linkColumnTsNames: readonly string[];
};

export type TableValidation = {
	accessor: string;
	modelName: string;
	select: ValidationField[];
	create: ValidationField[];
	update: ValidationField[];
	junction?: JunctionValidation;
};

export type ValidationIR = {
	enums: ValidationEnum[];
	tables: TableValidation[];
};
