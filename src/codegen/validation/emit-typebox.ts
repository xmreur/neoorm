import type {
	TableValidation,
	ValidationConstraints,
	ValidationField,
	ValidationIR,
	ValidationType,
} from "./types.js";

type RegisteredFormat = "uuid" | "email" | "url" | "date-time";

function emitLiteral(value: string | number | boolean): string {
	return `Type.Literal(${JSON.stringify(value)})`;
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
	return options !== undefined
		? `Type.${name}(${options})`
		: `Type.${name}()`;
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

function emitDecimalRefine(
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
	return `Type.Refine(${expr}, (value) => ${checks.join(" && ")})`;
}

function emitString(
	type: Extract<ValidationType, { kind: "string" }>,
	constraints: ValidationConstraints | undefined,
): string {
	const options = emitOptions({
		format:
			type.format !== undefined ? JSON.stringify(type.format) : undefined,
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
		return emitDecimalRefine(expr, constraints);
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
			return "Type.Boolean()";
		case "date":
			return "dateValue";
		case "enum":
			return type.name !== undefined
				? `${type.name}Schema`
				: `Type.Enum(${JSON.stringify(type.values)})`;
		case "unknown":
			return "Type.Unknown()";
		case "record": {
			const keyExpr =
				type.key !== undefined ? emitType(type.key) : "Type.String()";
			return `Type.Record(${keyExpr}, ${emitType(type.value)})`;
		}
		case "array":
			return `Type.Array(${emitType(type.element)})`;
		case "object":
			return `Type.Object({ ${type.fields.map(emitFieldInline).join(", ")} })`;
		case "union":
			return `Type.Union([${type.variants.map((variant) => emitType(variant)).join(", ")}])`;
		case "literal":
			return emitLiteral(type.value);
		case "tuple":
			return `Type.Tuple([${type.elements.map((element) => emitType(element)).join(", ")}])`;
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
		expr = `Type.Union([${expr}, Type.Null()])`;
	}
	if (field.optional) {
		expr = `Type.Optional(${expr})`;
	}
	return expr;
}

function emitFieldInline(field: ValidationField): string {
	return `${field.name}: ${emitFieldExpr(field)}`;
}

function emitObjectFields(fields: ValidationField[]): string {
	if (fields.length === 0) {
		return "Type.Object({})";
	}
	const body = fields
		.map((field) => `  ${field.name}: ${emitFieldExpr(field)},`)
		.join("\n");
	return `Type.Object({\n${body}\n})`;
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

function collectPrinterNeeds(ir: ValidationIR): {
	date: boolean;
	buffer: boolean;
	formats: Set<RegisteredFormat>;
} {
	const formats = new Set<RegisteredFormat>();
	let date = false;
	let buffer = false;

	const visit = (type: ValidationType): void => {
		switch (type.kind) {
			case "date":
				date = true;
				formats.add("date-time");
				return;
			case "instance":
				if (type.tsName === "Buffer") {
					buffer = true;
				}
				return;
			case "string":
				if (type.format !== undefined) {
					formats.add(type.format);
				}
				return;
			case "number":
			case "bigint":
			case "boolean":
			case "enum":
			case "unknown":
			case "record":
			case "array":
			case "object":
			case "union":
			case "literal":
			case "tuple":
				return;
			default: {
				const _exhaustive: never = type;
				throw _exhaustive;
			}
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

	return { date, buffer, formats };
}

const FORMAT_CHECKERS: Record<RegisteredFormat, string> = {
	uuid: "Format.IsUuid",
	email: "Format.IsEmail",
	url: "Format.IsUrl",
	"date-time": "Format.IsDateTime",
};

const DATE_VALUE_HELPER = `const dateValue = Type.Codec(
  Type.Union([
    Type.Refine(Type.Unsafe({}), (value) => value instanceof Date),
    Type.String({ format: "date-time" }),
  ]),
)
  .Decode((value) => (value instanceof Date ? value : new Date(value)))
  .Encode((value) => value);
`;

const BUFFER_VALUE_HELPER = `const bufferValue = Type.Refine(Type.Unsafe({}), (value) => Buffer.isBuffer(value));
`;

function emitFormatRegistrations(formats: Set<RegisteredFormat>): string[] {
	const order: RegisteredFormat[] = ["uuid", "email", "url", "date-time"];
	const lines: string[] = [];
	for (const format of order) {
		if (!formats.has(format)) {
			continue;
		}
		const checker = FORMAT_CHECKERS[format];
		lines.push(
			`if (!Format.Has(${JSON.stringify(format)})) Format.Set(${JSON.stringify(format)}, ${checker});`,
		);
	}
	return lines;
}

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

function emitTableTypebox(table: TableValidation, lines: string[]): string {
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
		`export type ${table.modelName}Select = Type.StaticDecode<typeof ${table.modelName}Schema>;`,
	);
	if (isJunction) {
		lines.push(
			`export type ${table.modelName}LinkCreate = Type.StaticDecode<typeof ${table.modelName}LinkCreateSchema>;`,
		);
	}
	lines.push(
		`export type ${table.modelName}Create = Type.StaticDecode<typeof ${table.modelName}CreateSchema>;`,
	);
	if (emitUpdate) {
		lines.push(
			`export type ${table.modelName}Update = Type.StaticDecode<typeof ${table.modelName}UpdateSchema>;`,
		);
	}
	lines.push("");

	if (emitUpdate) {
		return `  ${table.accessor}: { select: ${table.modelName}Schema, create: ${table.modelName}CreateSchema, update: ${table.modelName}UpdateSchema },`;
	}
	return `  ${table.accessor}: { select: ${table.modelName}Schema, create: ${table.modelName}CreateSchema },`;
}

/** Print validation IR as a TypeBox 1.x module. Does not read ManifestColumn kinds. */
export function emitTypeboxTs(ir: ValidationIR): string {
	const needs = collectPrinterNeeds(ir);
	const lines: string[] = [
		"// Auto-generated by neoorm generate — do not edit",
		'import Type from "typebox";',
	];
	if (needs.formats.size > 0) {
		lines.push('import Format from "typebox/format";');
	}
	lines.push("");

	const formatLines = emitFormatRegistrations(needs.formats);
	if (formatLines.length > 0) {
		lines.push(...formatLines);
		lines.push("");
	}

	if (needs.date) {
		lines.push(DATE_VALUE_HELPER);
	}
	if (needs.buffer) {
		lines.push(BUFFER_VALUE_HELPER);
	}

	for (const enumType of ir.enums) {
		lines.push(
			`export const ${enumType.name}Schema = Type.Enum(${JSON.stringify(enumType.values)});`,
		);
		lines.push(
			`export type ${enumType.name} = Type.StaticDecode<typeof ${enumType.name}Schema>;`,
		);
		lines.push("");
	}

	const schemaEntries: string[] = [];

	for (const table of ir.tables) {
		schemaEntries.push(emitTableTypebox(table, lines));
	}

	lines.push("export const schemas = {");
	lines.push(...schemaEntries);
	lines.push("} as const;");
	lines.push("");

	return lines.join("\n");
}
