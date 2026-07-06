import type { ManifestColumn } from "../../dialect/types.js";
import type { PluginWhereOperator } from "../types.js";

function jsonbCol(sqlCol: string, col: ManifestColumn): string {
	return col.kind === "json" ? `${sqlCol}::jsonb` : sqlCol;
}

function jsonParam(value: unknown): string {
	return JSON.stringify(value);
}

function pgPath(segments: readonly string[]): string {
	return `{${segments.join(",")}}`;
}

export const jsonWhereOperators: Record<string, PluginWhereOperator> = {
	jsonContains: {
		compile(sqlCol, value, col, startParamIndex) {
			const cast = jsonbCol(sqlCol, col);
			return {
				sql: `${cast} @> $${startParamIndex}::jsonb`,
				params: [jsonParam(value)],
			};
		},
	},
	hasKey: {
		compile(sqlCol, value, col, startParamIndex) {
			const cast = jsonbCol(sqlCol, col);
			return {
				sql: `${cast} ? $${startParamIndex}`,
				params: [value],
			};
		},
	},
	hasAnyKeys: {
		compile(sqlCol, value, col, startParamIndex) {
			const cast = jsonbCol(sqlCol, col);
			return {
				sql: `${cast} ?| $${startParamIndex}`,
				params: [value],
			};
		},
	},
	hasAllKeys: {
		compile(sqlCol, value, col, startParamIndex) {
			const cast = jsonbCol(sqlCol, col);
			return {
				sql: `${cast} ?& $${startParamIndex}`,
				params: [value],
			};
		},
	},
	path: {
		compile(sqlCol, value, col, startParamIndex) {
			const cast = jsonbCol(sqlCol, col);
			const spec = value as {
				segments: readonly string[];
				equals?: unknown;
				jsonContains?: unknown;
			};
			const pathLit = pgPath(spec.segments);
			if (spec.jsonContains !== undefined) {
				return {
					sql: `${cast} #> '${pathLit}' @> $${startParamIndex}::jsonb`,
					params: [jsonParam(spec.jsonContains)],
				};
			}
			return {
				sql: `${cast} #>> '${pathLit}' = $${startParamIndex}`,
				params: [spec.equals],
			};
		},
	},
};
