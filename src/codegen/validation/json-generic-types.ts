import { readFile } from "node:fs/promises";
import type { Manifest } from "../../dialect/types.js";
import type { ValidationField, ValidationType } from "./types.js";

type JsonColumnRef = {
	tableAccessor: string;
	columnName: string;
	validation: ValidationType;
};

function extractBalancedAngle(
	source: string,
	openIndex: number,
): { inner: string; end: number } | undefined {
	if (source[openIndex] !== "<") {
		return undefined;
	}
	let depth = 0;
	for (let i = openIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === "<") {
			depth++;
		} else if (ch === ">") {
			depth--;
			if (depth === 0) {
				return { inner: source.slice(openIndex + 1, i), end: i + 1 };
			}
		}
	}
	return undefined;
}

function tableAccessorBefore(
	source: string,
	columnIndex: number,
): string | undefined {
	const before = source.slice(0, columnIndex);
	const matches = [...before.matchAll(/(\w+)\s*:\s*table\s*\(/g)];
	return matches.at(-1)?.[1];
}

function collectJsonColumnRefs(source: string): JsonColumnRef[] {
	const refs: JsonColumnRef[] = [];
	const re = /(\w+)\s*:\s*(json|jsonb)\s*</g;
	for (const match of source.matchAll(re)) {
		if (match.index === undefined) {
			continue;
		}
		const columnName = match[1];
		const openIndex = match.index + match[0].length - 1;
		const balanced = extractBalancedAngle(source, openIndex);
		if (!columnName || !balanced) {
			continue;
		}
		const validation = parseTypeExpression(balanced.inner.trim());
		const tableAccessor = tableAccessorBefore(source, match.index);
		if (!validation || !tableAccessor) {
			continue;
		}
		refs.push({
			tableAccessor,
			columnName,
			validation,
		});
	}
	return refs;
}

function parseTypeExpression(input: string): ValidationType | undefined {
	const trimmed = input.trim();
	if (!trimmed) {
		return undefined;
	}
	const primitive = parsePrimitive(trimmed);
	if (primitive) {
		return primitive;
	}
	if (trimmed.startsWith("{")) {
		return parseObjectType(trimmed);
	}
	if (trimmed.endsWith("[]")) {
		const element = parseTypeExpression(trimmed.slice(0, -2));
		return element ? { kind: "array", element } : undefined;
	}
	const genericMatch = /^(\w+)\s*<([\s\S]+)>$/.exec(trimmed);
	if (genericMatch) {
		const name = genericMatch[1];
		const genericArgs = genericMatch[2];
		if (!name || !genericArgs) {
			return undefined;
		}
		const args = splitTopLevelGenericArgs(genericArgs);
		switch (name) {
			case "Record": {
				const keyArg = args[0];
				const valueArg = args[1];
				if (keyArg !== undefined && valueArg !== undefined) {
					return {
						kind: "record",
						key: parseTypeExpression(keyArg) ?? { kind: "string" },
						value: parseTypeExpression(valueArg) ?? {
							kind: "unknown",
						},
					};
				}
				return { kind: "record", value: { kind: "unknown" } };
			}
			case "Array": {
				const elementArg = args[0];
				if (elementArg !== undefined) {
					return {
						kind: "array",
						element: parseTypeExpression(elementArg) ?? {
							kind: "unknown",
						},
					};
				}
				return undefined;
			}
			default:
				return undefined;
		}
	}
	if (trimmed.includes("|")) {
		const variants = splitUnion(trimmed)
			.map((part) => parseTypeExpression(part))
			.filter((part): part is ValidationType => part !== undefined);
		if (variants.length === 0) {
			return undefined;
		}
		if (variants.length === 1) {
			return variants[0];
		}
		return { kind: "union", variants };
	}
	return undefined;
}

function parsePrimitive(input: string): ValidationType | undefined {
	switch (input) {
		case "string":
			return { kind: "string" };
		case "number":
			return { kind: "number" };
		case "boolean":
			return { kind: "boolean" };
		case "bigint":
			return { kind: "bigint" };
		case "unknown":
		case "any":
			return { kind: "unknown" };
		case "Date":
			return { kind: "date" };
		case "Buffer":
			return { kind: "instance", tsName: "Buffer" };
		default:
			return undefined;
	}
}

function parseObjectType(input: string): ValidationType | undefined {
	if (!input.startsWith("{") || !input.endsWith("}")) {
		return undefined;
	}
	const inner = input.slice(1, -1);
	const members = splitTopLevel(inner, ";");
	const fields: ValidationField[] = [];
	for (const member of members) {
		const field = parseObjectMember(member.trim());
		if (field) {
			fields.push(field);
		}
	}
	return { kind: "object", fields };
}

function parseObjectMember(member: string): ValidationField | undefined {
	if (!member) {
		return undefined;
	}
	const colon = findTopLevelColon(member);
	if (colon < 0) {
		return undefined;
	}
	const namePart = member.slice(0, colon).trim();
	const typePart = member.slice(colon + 1).trim();
	const optional = namePart.endsWith("?");
	const name = optional ? namePart.slice(0, -1).trim() : namePart;
	if (!/^\w+$/.test(name)) {
		return undefined;
	}
	let nullable = false;
	let typeSource = typePart;
	if (typeSource.includes("|")) {
		const parts = splitUnion(typeSource);
		const nonNullish = parts.filter(
			(part) => part !== "null" && part !== "undefined",
		);
		nullable = parts.includes("null");
		const optionalFromUnion = parts.includes("undefined");
		if (nonNullish.length === 1) {
			const only = nonNullish[0];
			if (only === undefined) {
				return undefined;
			}
			typeSource = only;
		} else if (nonNullish.length > 1) {
			const variants = nonNullish
				.map((part) => parseTypeExpression(part))
				.filter((part): part is ValidationType => part !== undefined);
			if (variants.length === 0) {
				return undefined;
			}
			const singleVariant = variants.at(0);
			const unionType: ValidationType =
				variants.length === 1 && singleVariant !== undefined
					? singleVariant
					: { kind: "union", variants };
			return {
				name,
				type: unionType,
				nullable,
				optional: optional || optionalFromUnion,
			};
		} else {
			return undefined;
		}
	}
	const type = parseTypeExpression(typeSource);
	if (!type) {
		return undefined;
	}
	return {
		name,
		type,
		nullable,
		optional,
	};
}

function findTopLevelColon(input: string): number {
	let depthBrace = 0;
	let depthAngle = 0;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "{") depthBrace++;
		else if (ch === "}") depthBrace--;
		else if (ch === "<") depthAngle++;
		else if (ch === ">") depthAngle--;
		else if (ch === ":" && depthBrace === 0 && depthAngle === 0) {
			return i;
		}
	}
	return -1;
}

function splitTopLevel(input: string, separator: string): string[] {
	const parts: string[] = [];
	let depthBrace = 0;
	let depthAngle = 0;
	let depthParen = 0;
	let start = 0;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "{") depthBrace++;
		else if (ch === "}") depthBrace--;
		else if (ch === "<") depthAngle++;
		else if (ch === ">") depthAngle--;
		else if (ch === "(") depthParen++;
		else if (ch === ")") depthParen--;
		else if (
			ch === separator &&
			depthBrace === 0 &&
			depthAngle === 0 &&
			depthParen === 0
		) {
			parts.push(input.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(input.slice(start));
	return parts;
}

function splitUnion(input: string): string[] {
	return splitTopLevel(input, "|").map((part) => part.trim());
}

function splitTopLevelGenericArgs(input: string): string[] {
	return splitTopLevel(input, ",").map((part) => part.trim());
}

/**
 * Read `json()` / `jsonb()` type arguments from `schema.ts` and attach them to
 * manifest columns for validation codegen. Explicit `.schema()` validation wins.
 */
export async function applyJsonGenericTypesFromSchema(
	schemaPath: string,
	manifest: Manifest,
): Promise<void> {
	const sourceText = await readFile(schemaPath, "utf-8");

	for (const ref of collectJsonColumnRefs(sourceText)) {
		const table = manifest.tables[ref.tableAccessor];
		if (!table) {
			continue;
		}
		const column = table.columns.find(
			(col) => col.tsName === ref.columnName,
		);
		if (
			!column ||
			(column.kind !== "json" && column.kind !== "jsonb") ||
			column.validation !== undefined
		) {
			continue;
		}
		column.validation = ref.validation;
	}
}
