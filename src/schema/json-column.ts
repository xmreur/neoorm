import type { ValidationType } from "../codegen/validation/types.js";
import type { ColumnBuilder, ColumnMeta } from "./column.js";

export type JsonValidationMethods = {
	schema(validation: ValidationType): JsonColumnBuilder<unknown | null>;
};

/** JSON / JSONB column builder with optional validation IR for Zod codegen. */
export type JsonColumnBuilder<TValue> = ColumnBuilder<TValue, ColumnMeta> &
	JsonValidationMethods;

export function createJsonValidationExtras<TValue, TMeta extends ColumnMeta>(
	meta: TMeta,
	rebuild: (
		nextMeta: TMeta,
	) => ColumnBuilder<TValue, TMeta> & JsonValidationMethods,
): JsonValidationMethods {
	return {
		schema(validation: ValidationType) {
			return rebuild({ ...meta, validation } as TMeta) as JsonColumnBuilder<
				unknown | null
			>;
		},
	};
}
