import type {
	ValidationConstraints,
	ValidationField,
	ValidationIR,
	ValidationType,
} from "./types.js";

function emitLiteral(value: string | number | boolean): string {
	return `z.literal(${JSON.stringify(value)})`;
}

function emitInstance(tsName: "Buffer"): string {
	switch (tsName) {
		case "Buffer":
			return "z.custom<Buffer>((v) => Buffer.isBuffer(v))";
		default: {
			const _exhaustive: never = tsName;
			return _exhaustive;
		}
	}
}

function emitType(type: ValidationType): string {
	switch (type.kind) {
		case "string":
			switch (type.format) {
				case "uuid":
					return "z.uuid()";
				case "email":
					return "z.email()";
				case "url":
					return "z.url()";
				case undefined:
					return "z.string()";
				default: {
					const _exhaustive: never = type.format;
					return _exhaustive;
				}
			}
		case "number":
			return type.int === true ? "z.number().int()" : "z.number()";
		case "bigint":
			return "z.bigint()";
		case "boolean":
			return "z.boolean()";
		case "date":
			return "dateValue";
		case "enum":
			return type.name !== undefined
				? `${type.name}Schema`
				: `z.enum(${JSON.stringify(type.values)})`;
		case "unknown":
			return "z.unknown()";
		case "array":
			return `z.array(${emitType(type.element)})`;
		case "object":
			return `z.object({ ${type.fields.map(emitFieldInline).join(", ")} })`;
		case "union":
			return `z.union([${type.variants.map(emitType).join(", ")}])`;
		case "literal":
			return emitLiteral(type.value);
		case "tuple":
			return `z.tuple([${type.elements.map(emitType).join(", ")}])`;
		case "instance":
			return emitInstance(type.tsName);
		default: {
			const _exhaustive: never = type;
			return _exhaustive;
		}
	}
}

function bigintLiteral(value: number | string): string {
	return `BigInt(${JSON.stringify(String(value))})`;
}

function numberLiteral(value: number | string): string {
	if (typeof value === "number") {
		return String(value);
	}
	return String(Number(value));
}

function applyDecimalRefine(
	expr: string,
	constraints: ValidationConstraints,
): string {
	const checks: string[] = [];
	if (constraints.min !== undefined) {
		checks.push(`Number(value) >= ${numberLiteral(constraints.min)}`);
	}
	if (constraints.max !== undefined) {
		checks.push(`Number(value) <= ${numberLiteral(constraints.max)}`);
	}
	if (constraints.positive === true) {
		checks.push("Number(value) > 0");
	}
	if (checks.length === 0) {
		return expr;
	}
	return `${expr}.refine((value) => ${checks.join(" && ")})`;
}

function applyConstraints(
	expr: string,
	type: ValidationType,
	constraints: ValidationConstraints | undefined,
): string {
	if (!constraints) {
		return expr;
	}

	switch (type.kind) {
		case "string": {
			let next = expr;
			if (constraints.minLength !== undefined) {
				next = `${next}.min(${constraints.minLength})`;
			}
			if (constraints.maxLength !== undefined) {
				next = `${next}.max(${constraints.maxLength})`;
			}
			if (
				constraints.min !== undefined ||
				constraints.max !== undefined ||
				constraints.positive === true
			) {
				next = applyDecimalRefine(next, constraints);
			}
			return next;
		}
		case "number": {
			let next = expr;
			if (constraints.min !== undefined) {
				next = `${next}.min(${numberLiteral(constraints.min)})`;
			}
			if (constraints.max !== undefined) {
				next = `${next}.max(${numberLiteral(constraints.max)})`;
			}
			if (constraints.positive === true) {
				next = `${next}.positive()`;
			}
			return next;
		}
		case "bigint": {
			let next = expr;
			if (constraints.min !== undefined) {
				next = `${next}.min(${bigintLiteral(constraints.min)})`;
			}
			if (constraints.max !== undefined) {
				next = `${next}.max(${bigintLiteral(constraints.max)})`;
			}
			if (constraints.positive === true) {
				next = `${next}.positive()`;
			}
			return next;
		}
		case "boolean":
		case "date":
		case "enum":
		case "unknown":
		case "array":
		case "object":
		case "union":
		case "literal":
		case "tuple":
		case "instance":
			return expr;
		default: {
			const _exhaustive: never = type;
			return _exhaustive;
		}
	}
}

function emitFieldExpr(field: ValidationField): string {
	let expr = emitType(field.type);
	expr = applyConstraints(expr, field.type, field.constraints);
	if (field.nullable) {
		expr = `${expr}.nullable()`;
	}
	if (field.optional) {
		expr = `${expr}.optional()`;
	}
	return expr;
}

function emitFieldInline(field: ValidationField): string {
	return `${field.name}: ${emitFieldExpr(field)}`;
}

function emitObjectFields(fields: ValidationField[]): string {
	if (fields.length === 0) {
		return "z.object({})";
	}
	const body = fields
		.map((field) => `  ${field.name}: ${emitFieldExpr(field)},`)
		.join("\n");
	return `z.object({\n${body}\n})`;
}

function typeHasDate(type: ValidationType): boolean {
	switch (type.kind) {
		case "date":
			return true;
		case "array":
			return typeHasDate(type.element);
		case "union":
			return type.variants.some(typeHasDate);
		case "tuple":
			return type.elements.some(typeHasDate);
		case "object":
			return type.fields.some((field) => typeHasDate(field.type));
		case "string":
		case "number":
		case "bigint":
		case "boolean":
		case "enum":
		case "unknown":
		case "literal":
		case "instance":
			return false;
		default: {
			const _exhaustive: never = type;
			return _exhaustive;
		}
	}
}

function irHasDate(ir: ValidationIR): boolean {
	return ir.tables.some((table) =>
		[...table.select, ...table.create, ...table.update].some((field) =>
			typeHasDate(field.type),
		),
	);
}

const DATE_VALUE_HELPER = `const dateValue = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((value) => (value instanceof Date ? value : new Date(value)));
`;

/** Print validation IR as a Zod 4 module. Does not read ManifestColumn kinds. */
export function emitZodTs(ir: ValidationIR): string {
	const lines: string[] = [
		"// Auto-generated by neoorm generate — do not edit",
		'import { z } from "zod";',
		"",
	];

	if (irHasDate(ir)) {
		lines.push(DATE_VALUE_HELPER);
	}

	for (const enumType of ir.enums) {
		lines.push(
			`export const ${enumType.name}Schema = z.enum(${JSON.stringify(enumType.values)});`,
		);
		lines.push(
			`export type ${enumType.name} = z.infer<typeof ${enumType.name}Schema>;`,
		);
		lines.push("");
	}

	const schemaEntries: string[] = [];

	for (const table of ir.tables) {
		lines.push(
			`export const ${table.modelName}Schema = ${emitObjectFields(table.select)};`,
		);
		lines.push("");
		lines.push(
			`export const ${table.modelName}CreateSchema = ${emitObjectFields(table.create)};`,
		);
		lines.push("");
		lines.push(
			`export const ${table.modelName}UpdateSchema = ${emitObjectFields(table.update)};`,
		);
		lines.push("");
		lines.push(
			`export type ${table.modelName}Select = z.infer<typeof ${table.modelName}Schema>;`,
		);
		lines.push(
			`export type ${table.modelName}Create = z.infer<typeof ${table.modelName}CreateSchema>;`,
		);
		lines.push(
			`export type ${table.modelName}Update = z.infer<typeof ${table.modelName}UpdateSchema>;`,
		);
		lines.push("");

		schemaEntries.push(
			`  ${table.accessor}: { select: ${table.modelName}Schema, create: ${table.modelName}CreateSchema, update: ${table.modelName}UpdateSchema },`,
		);
	}

	lines.push("export const schemas = {");
	lines.push(...schemaEntries);
	lines.push("} as const;");
	lines.push("");

	return lines.join("\n");
}
