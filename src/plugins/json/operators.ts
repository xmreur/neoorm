import type { ManifestColumn } from "../../dialect/types.js";
import type { PluginWhereOperator } from "../types.js";

function jsonbCol(sqlCol: string, col: ManifestColumn): string {
	return col.kind === "json" ? `${sqlCol}::jsonb` : sqlCol;
}

function jsonParam(value: unknown): string {
	return JSON.stringify(value);
}

function pgPath(segments: readonly string[]): string {
	return `{${segments.map(escapeArrayElement).join(",")}}`;
}

function escapeArrayElement(segment: string): string {
	if (/^[^{},\s"\\]+$/.test(segment)) {
		return segment;
	}
	return `"${segment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sqliteJsonPath(segments: readonly string[]): string {
	let path = "$";
	for (const segment of segments) {
		if (/^\d+$/.test(segment)) {
			path += `[${segment}]`;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
			path += `.${segment}`;
			continue;
		}
		path += `."${segment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return path;
}

function sqliteContainsSql(targetExpr: string, paramIndex: number): string {
	return `json(json_patch(${targetExpr}, $${paramIndex})) = json(${targetExpr})`;
}

function sqliteKeyMatchSql(columnExpr: string, paramRef: string): string {
	return `CASE json_type(${columnExpr}) WHEN 'object' THEN "_jk".key = ${paramRef} ELSE "_jk".value = ${paramRef} END`;
}

type PathSpec = {
	segments: readonly string[];
	equals?: unknown;
	jsonContains?: unknown;
};

type JsonWhereOp =
	| "jsonContains"
	| "hasKey"
	| "hasAnyKeys"
	| "hasAllKeys"
	| "path";

function compilePostgres(
	op: JsonWhereOp,
	sqlCol: string,
	value: unknown,
	col: ManifestColumn,
	startParamIndex: number,
): { sql: string; params: unknown[] } {
	const cast = jsonbCol(sqlCol, col);
	switch (op) {
		case "jsonContains":
			return {
				sql: `${cast} @> $${startParamIndex}::jsonb`,
				params: [jsonParam(value)],
			};
		case "hasKey":
			return {
				sql: `${cast} ? $${startParamIndex}`,
				params: [value],
			};
		case "hasAnyKeys":
			return {
				sql: `${cast} ?| $${startParamIndex}`,
				params: [value],
			};
		case "hasAllKeys":
			return {
				sql: `${cast} ?& $${startParamIndex}`,
				params: [value],
			};
		case "path": {
			const spec = value as PathSpec;
			const pathLit = pgPath(spec.segments);
			const pathParam = `$${startParamIndex}`;
			if (spec.jsonContains !== undefined) {
				return {
					sql: `${cast} #> ${pathParam} @> $${startParamIndex + 1}::jsonb`,
					params: [pathLit, jsonParam(spec.jsonContains)],
				};
			}
			return {
				sql: `${cast} #>> ${pathParam} = $${startParamIndex + 1}`,
				params: [pathLit, spec.equals],
			};
		}
		default: {
			const _exhaustive: never = op;
			return _exhaustive;
		}
	}
}

function compileSqlite(
	op: JsonWhereOp,
	sqlCol: string,
	value: unknown,
	startParamIndex: number,
): { sql: string; params: unknown[] } {
	switch (op) {
		case "jsonContains":
			return {
				sql: sqliteContainsSql(sqlCol, startParamIndex),
				params: [jsonParam(value)],
			};
		case "hasKey": {
			const keyMatch = sqliteKeyMatchSql(sqlCol, `$${startParamIndex}`);
			return {
				sql: `EXISTS (SELECT 1 FROM json_each(${sqlCol}) AS "_jk" WHERE ${keyMatch})`,
				params: [value],
			};
		}
		case "hasAnyKeys": {
			const keyMatch = sqliteKeyMatchSql(sqlCol, `"_nk".value`);
			return {
				sql: `EXISTS (SELECT 1 FROM json_each(${sqlCol}) AS "_jk" JOIN json_each($${startParamIndex}) AS "_nk" ON ${keyMatch})`,
				params: [value],
			};
		}
		case "hasAllKeys": {
			const keyMatch = sqliteKeyMatchSql(sqlCol, `"_nk".value`);
			return {
				sql: `NOT EXISTS (SELECT 1 FROM json_each($${startParamIndex}) AS "_nk" WHERE NOT EXISTS (SELECT 1 FROM json_each(${sqlCol}) AS "_jk" WHERE ${keyMatch}))`,
				params: [value],
			};
		}
		case "path": {
			const spec = value as PathSpec;
			const pathLit = sqliteJsonPath(spec.segments);
			if (spec.jsonContains !== undefined) {
				// SQLite binds each `?` once; extract in a subquery so `$path` is not repeated.
				return {
					sql: `EXISTS (SELECT 1 FROM (SELECT json_extract(${sqlCol}, $${startParamIndex}) AS "_jv") AS "_jp" WHERE ${sqliteContainsSql(`"_jp"."_jv"`, startParamIndex + 1)})`,
					params: [pathLit, jsonParam(spec.jsonContains)],
				};
			}
			return {
				sql: `json_extract(${sqlCol}, $${startParamIndex}) = $${startParamIndex + 1}`,
				params: [pathLit, spec.equals],
			};
		}
		default: {
			const _exhaustive: never = op;
			return _exhaustive;
		}
	}
}

function jsonOperator(op: JsonWhereOp): PluginWhereOperator {
	return {
		compile(sqlCol, value, col, startParamIndex, dialect) {
			if (dialect.name === "sqlite") {
				return compileSqlite(op, sqlCol, value, startParamIndex);
			}
			return compilePostgres(op, sqlCol, value, col, startParamIndex);
		},
	};
}

export const jsonWhereOperators: Record<string, PluginWhereOperator> = {
	jsonContains: jsonOperator("jsonContains"),
	hasKey: jsonOperator("hasKey"),
	hasAnyKeys: jsonOperator("hasAnyKeys"),
	hasAllKeys: jsonOperator("hasAllKeys"),
	path: jsonOperator("path"),
};
