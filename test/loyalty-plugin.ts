import { registerPlugin } from "../src/plugins/registry.js";
import { type ColumnMeta, createColumnBuilder } from "../src/schema/column.js";

export function loyalty() {
	return createColumnBuilder<string | null, ColumnMeta>({
		kind: "loyalty",
		nullable: true,
		unique: false,
		primary: false,
		defaultNow: false,
	});
}

registerPlugin({
	name: "loyalty-plugin",
	columnTypes: [
		{
			kind: "loyalty",
			createBuilder() {
				return loyalty();
			},
			columnType() {
				return "NUMERIC(19,4)";
			},
			columnTsType(col) {
				return col.nullable ? "string | null" : "string";
			},
			whereOperators: {
				overlaps: {
					compile(sqlCol, _value, _col, startParamIndex) {
						return {
							sql: `${sqlCol} && $${startParamIndex}`,
							params: ["x"],
						};
					},
				},
			},
		},
	],
});
