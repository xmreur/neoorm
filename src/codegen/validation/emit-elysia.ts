import type {
	TableValidation,
	ValidationConstraints,
	ValidationField,
	ValidationIR,
	ValidationType,
} from "./types.js";

function emitLiteral(value: string | number | boolean): string {
	return `t.Literal(${JSON.stringify(value)})`;
}

function emitOptions(
	fields: Record<string, string | undefined>,
): string | undefined {
	const entries = Object.entries(fields).filter(
		(entry): entry is [string, string] => entry[1] !== undefined,
	);
	if (entries.length === 0) {
		return undefined;
	}
	return `{ ${entries.map(([key, value]) => `${key}: ${value}`).join(", ")} }`;
}

function callType(name: string, options: string | undefined): string {
	return options !== undefined ? `t.${name}(${options})` : `t.${name}()`;
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

function stringFormat(format: "uuid" | "email" | "url"): string {
	switch (format) {
		case "uuid":
			return "uuid";
		case "email":
			return "email";
		case "url":
			return "uri";
		default: {
			const _exhaustive: never = format;
			return _exhaustive;
		}
	}
}

function emitDecimalTransform(
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
	return `t.Transform(${expr}).Decode((value) => { if (!(${checks.join(" && ")})) throw new Error("Invalid decimal"); return value; }).Encode((value) => value)`;
}

function emitString(
	type: Extract<ValidationType, { kind: "string" }>,
	constraints: ValidationConstraints | undefined,
): string {
	const options = emitOptions({
		format:
			type.format !== undefined
				? JSON.stringify(stringFormat(type.format))
				: undefined,
		minLength:
			constraints?.minLength !== undefined
				? String(constraints.minLength)
				: undefined,
		maxLength:
			constraints?.maxLength !== undefined
				? String(constraints.maxLength)
				: undefined,
	});
	const expr = callType("String", options);
	if (
		constraints !== undefined &&
		(constraints.min !== undefined ||
			constraints.max !== undefined ||
			constraints.positive === true)
	) {
		return emitDecimalTransform(expr, constraints);
	}
	return expr;
}

function emitNumber(
	type: Extract<ValidationType, { kind: "number" }>,
	constraints: ValidationConstraints | undefined,
): string {
	const options = emitOptions({
		minimum:
			constraints?.min !== undefined
				? numberLiteral(constraints.min)
				: undefined,
		maximum:
			constraints?.max !== undefined
				? numberLiteral(constraints.max)
				: undefined,
		exclusiveMinimum: constraints?.positive === true ? "0" : undefined,
	});
	return callType(type.int === true ? "Integer" : "Number", options);
}

function emitBigInt(constraints: ValidationConstraints | undefined): string {
	const options = emitOptions({
		minimum:
			constraints?.min !== undefined
				? bigintLiteral(constraints.min)
				: undefined,
		maximum:
			constraints?.max !== undefined
				? bigintLiteral(constraints.max)
				: undefined,
		exclusiveMinimum: constraints?.positive === true ? "0n" : undefined,
	});
	return callType("BigInt", options);
}

function emitType(
	type: ValidationType,
	constraints?: ValidationConstraints,
): string {
	switch (type.kind) {
		case "string":
			return emitString(type, constraints);
		case "number":
			return emitNumber(type, constraints);
		case "bigint":
			return emitBigInt(constraints);
		case "boolean":
			return "t.Boolean()";
		case "date":
			return "t.Date()";
		case "enum":
			return type.name !== undefined
				? `${type.name}Schema`
				: `t.UnionEnum(${JSON.stringify(type.values)})`;
		case "unknown":
			return "t.Unknown()";
		case "record": {
			const keyExpr =
				type.key !== undefined ? emitType(type.key) : "t.String()";
			return `t.Record(${keyExpr}, ${emitType(type.value)})`;
		}
		case "array":
			return `t.Array(${emitType(type.element)})`;
		case "object":
			return `t.Object({ ${type.fields.map(emitFieldInline).join(", ")} })`;
		case "union":
			return `t.Union([${type.variants.map((variant) => emitType(variant)).join(", ")}])`;
		case "literal":
			return emitLiteral(type.value);
		case "tuple":
			return `t.Tuple([${type.elements.map((element) => emitType(element)).join(", ")}])`;
		case "instance":
			switch (type.tsName) {
				case "Buffer":
					return "bufferValue";
				default: {
					const _exhaustive: never = type.tsName;
					return _exhaustive;
				}
			}
		default: {
			const _exhaustive: never = type;
			throw _exhaustive;
		}
	}
}

function emitFieldExpr(field: ValidationField): string {
	let expr = emitType(field.type, field.constraints);
	if (field.nullable) {
		expr = `t.Nullable(${expr})`;
	}
	if (field.optional) {
		expr = `t.Optional(${expr})`;
	}
	return expr;
}

function emitFieldInline(field: ValidationField): string {
	return `${field.name}: ${emitFieldExpr(field)}`;
}

function emitObjectFields(fields: ValidationField[]): string {
	if (fields.length === 0) {
		return "t.Object({})";
	}
	const body = fields
		.map((field) => `  ${field.name}: ${emitFieldExpr(field)},`)
		.join("\n");
	return `t.Object({\n${body}\n})`;
}

function walkType(
	type: ValidationType,
	visit: (type: ValidationType) => void,
): void {
	visit(type);
	switch (type.kind) {
		case "record":
			if (type.key !== undefined) {
				walkType(type.key, visit);
			}
			walkType(type.value, visit);
			return;
		case "array":
			walkType(type.element, visit);
			return;
		case "object":
			for (const field of type.fields) {
				walkType(field.type, visit);
			}
			return;
		case "union":
			for (const variant of type.variants) {
				walkType(variant, visit);
			}
			return;
		case "tuple":
			for (const element of type.elements) {
				walkType(element, visit);
			}
			return;
		case "string":
		case "number":
		case "bigint":
		case "boolean":
		case "date":
		case "enum":
		case "unknown":
		case "literal":
		case "instance":
			return;
		default: {
			const _exhaustive: never = type;
			throw _exhaustive;
		}
	}
}

function irHasBuffer(ir: ValidationIR): boolean {
	let buffer = false;
	const visit = (type: ValidationType): void => {
		if (type.kind === "instance" && type.tsName === "Buffer") {
			buffer = true;
		}
	};
	for (const table of ir.tables) {
		for (const field of [
			...table.select,
			...table.create,
			...table.update,
		]) {
			walkType(field.type, visit);
		}
	}
	return buffer;
}

const BUFFER_VALUE_HELPER = `const bufferValue = t.Transform(t.Any()).Decode((value) => { if (!Buffer.isBuffer(value)) throw new Error("Expected Buffer"); return value; }).Encode((value) => value);
`;

function emitJunctionComment(table: TableValidation): string[] {
	const junction = table.junction;
	if (!junction) {
		return [];
	}
	return [
		`// Many-to-many junction for ${junction.leftAccessor}.${junction.relationAs} ↔ ${junction.rightAccessor}.${junction.inverseAs}.`,
		`// Prefer nested writes: db.${junction.leftAccessor}.update({ data: { ${junction.relationAs}: { connect: [{ id }] } } })`,
		`// Direct inserts use ${table.modelName}LinkCreateSchema (both FK ids).`,
	];
}

function emitTableElysia(table: TableValidation, lines: string[]): string {
	const isJunction = table.junction !== undefined;
	if (isJunction) {
		lines.push(...emitJunctionComment(table));
	}

	lines.push(
		`export const ${table.modelName}Schema = ${emitObjectFields(table.select)};`,
	);
	lines.push("");

	if (isJunction) {
		lines.push(
			`export const ${table.modelName}LinkCreateSchema = ${emitObjectFields(table.create)};`,
		);
		lines.push(
			`export const ${table.modelName}CreateSchema = ${table.modelName}LinkCreateSchema;`,
		);
	} else {
		lines.push(
			`export const ${table.modelName}CreateSchema = ${emitObjectFields(table.create)};`,
		);
	}
	lines.push("");

	const emitUpdate = !isJunction || table.update.length > 0;
	if (emitUpdate) {
		lines.push(
			`export const ${table.modelName}UpdateSchema = ${emitObjectFields(table.update)};`,
		);
		lines.push("");
	} else if (table.junction) {
		lines.push(
			`// No scalar updates on junction rows — use nested relation writes on ${table.junction.leftAccessor}.${table.junction.relationAs}`,
		);
		lines.push("");
	}

	lines.push(
		`export type ${table.modelName}Select = typeof ${table.modelName}Schema.static;`,
	);
	if (isJunction) {
		lines.push(
			`export type ${table.modelName}LinkCreate = typeof ${table.modelName}LinkCreateSchema.static;`,
		);
	}
	lines.push(
		`export type ${table.modelName}Create = typeof ${table.modelName}CreateSchema.static;`,
	);
	if (emitUpdate) {
		lines.push(
			`export type ${table.modelName}Update = typeof ${table.modelName}UpdateSchema.static;`,
		);
	}
	lines.push("");

	if (emitUpdate) {
		return `  ${table.accessor}: { select: ${table.modelName}Schema, create: ${table.modelName}CreateSchema, update: ${table.modelName}UpdateSchema },`;
	}
	return `  ${table.accessor}: { select: ${table.modelName}Schema, create: ${table.modelName}CreateSchema },`;
}

/** Print validation IR as an Elysia `t` module. Does not read ManifestColumn kinds. */
export function emitElysiaTs(ir: ValidationIR): string {
	const lines: string[] = [
		"// Auto-generated by neoorm generate — do not edit",
		'import { t } from "elysia";',
		"",
	];

	if (irHasBuffer(ir)) {
		lines.push(BUFFER_VALUE_HELPER);
	}

	for (const enumType of ir.enums) {
		lines.push(
			`export const ${enumType.name}Schema = t.UnionEnum(${JSON.stringify(enumType.values)});`,
		);
		lines.push(
			`export type ${enumType.name} = typeof ${enumType.name}Schema.static;`,
		);
		lines.push("");
	}

	const schemaEntries: string[] = [];

	for (const table of ir.tables) {
		schemaEntries.push(emitTableElysia(table, lines));
	}

	lines.push("export const schemas = {");
	lines.push(...schemaEntries);
	lines.push("} as const;");
	lines.push("");

	return lines.join("\n");
}
