import { sanitizeTsIdentifier } from "../utils/case.js";

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Property name in generated TypeScript. Valid identifiers stay bare;
 * anything else is a quoted literal so a `"` or newline cannot break the file.
 */
export function tsPropertyKey(name: string): string {
	return TS_IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** TypeScript string literal, with quotes and escapes. */
export function tsStringLiteral(value: string): string {
	return JSON.stringify(value);
}

/** Member access: `.foo` when `name` is a valid identifier, otherwise `["…"]`. */
export function tsMemberAccess(object: string, name: string): string {
	return TS_IDENTIFIER.test(name)
		? `${object}.${name}`
		: `${object}[${JSON.stringify(name)}]`;
}

/** Identifier safe to use as a generated type or value name. */
export function tsTypeName(name: string): string {
	return sanitizeTsIdentifier(name);
}
