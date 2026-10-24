import { tsMemberAccess, tsPropertyKey } from "../codegen/ts-syntax.js";
import { manifestIndexKeys } from "../dialect/shared.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestTable,
} from "../dialect/types.js";
import type { DatabaseClient } from "../runtime/driver.js";
import type { ColumnNaming } from "../schema/table.js";
import {
	escapeTsString,
	resolveSqlColumnName,
	toCamelCase,
} from "../utils/case.js";
import { singularize } from "../utils/inflect.js";
import { introspectMysqlToManifest } from "./mysql/to-manifest.js";
import { introspectSqliteToManifest } from "./sqlite/to-manifest.js";
import { introspectToManifest } from "./to-manifest.js";

function inferFkAs(tsName: string): string {
	return tsName.replace(/_(Id|id)$/, "").replace(/Id$/, "");
}

/**
 * Per-emission naming state for a pulled schema. A relation name must be
 * unique per table and must not collide with a column name (the generated
 * query types place scalar filters keyed by `column.tsName` and relation
 * filters keyed by `relation.name` into the same interfaces), so every name
 * picked while emitting is reserved immediately.
 *
 * Forward relation names are reserved on the source table, inverse relation
 * names on the target table: a table's property names form a single
 * namespace, whatever direction the relation points in.
 */
type PullNameTracker = {
	/** Relation names picked so far, keyed by the table they will appear on. */
	assigned: Map<string, Set<string>>;
	/** Static property names per table: its column tsNames. */
	columnNames: Map<string, Set<string>>;
};

function pullNameTracker(manifest: Manifest): PullNameTracker {
	const columnNames = new Map<string, Set<string>>();
	for (const table of Object.values(manifest.tables)) {
		columnNames.set(
			table.accessor,
			new Set(table.columns.map((c) => c.tsName)),
		);
	}
	return { assigned: new Map(), columnNames };
}

/**
 * Names the emitted schema already defines on a table: its column tsNames
 * plus every relation name (forward, inverse) picked so far.
 */
function reservedNamesOnTable(
	tracker: PullNameTracker,
	accessor: string,
): Set<string> {
	const used = new Set(tracker.columnNames.get(accessor) ?? []);
	const extra = tracker.assigned.get(accessor);
	if (extra) {
		for (const name of extra) {
			used.add(name);
		}
	}
	return used;
}

/** Reserve a relation name so later picks (and their suffixes) cannot reuse it. */
function reserveRelationName(
	tracker: PullNameTracker,
	accessor: string,
	name: string,
): void {
	let extra = tracker.assigned.get(accessor);
	if (!extra) {
		extra = new Set<string>();
		tracker.assigned.set(accessor, extra);
	}
	extra.add(name);
}

/** Deterministic unused variant of `base` in `used`: base, base2, base3, … */
function withSuffix(base: string, used: Set<string>): string {
	if (!used.has(base)) {
		return base;
	}
	let index = 2;
	while (used.has(`${base}${index}`)) {
		index += 1;
	}
	return `${base}${index}`;
}

/** Accessor of an fk column's target table ("" when unresolved). */
function fkTargetAccessor(col: ManifestColumn, manifest: Manifest): string {
	const targetRef = resolveFkAccessorTarget(col, manifest);
	return targetRef.includes(".")
		? targetRef.slice(0, targetRef.indexOf("."))
		: targetRef;
}

/**
 * Forward relation name an FK column is emitted with in a pulled schema:
 * the stored/inferred name when it is free on the table. When the name is
 * already defined — as the fk's own column, a sibling column, or a relation
 * picked for an earlier fk — the fallback prefers the singular target table
 * name (the `userId → user` convention) for an Id-less fk column, then
 * suffixes the preferred name: `statusChangedBy2`, `statusChangedBy3`, …
 */
function pulledFkRelationName(
	col: ManifestColumn,
	table: ManifestTable,
	manifest: Manifest,
	tracker: PullNameTracker,
): string {
	const inferred = inferFkAs(col.tsName);
	const stored =
		col.fkAs !== undefined && col.fkAs !== "" ? col.fkAs : inferred;
	const used = reservedNamesOnTable(tracker, table.accessor);
	let name = stored;
	if (used.has(name)) {
		let base = stored;
		if (stored === col.tsName) {
			const targetAccessor = fkTargetAccessor(col, manifest);
			base =
				targetAccessor !== ""
					? singularize(targetAccessor)
					: `${inferred}Relation`;
		}
		name = withSuffix(base, used);
	}
	reserveRelationName(tracker, table.accessor, name);
	return name;
}

/**
 * Inverse relation name for an fk into `targetAccessor`: the source table
 * accessor (singularized for unique/one-to-one fks). The default name is
 * always reserved on the target table — without reserving it, a second fk
 * to the same target would emit a second relation under the same default
 * inverse name, which generate rejects with `duplicate_inverse`.
 */
function pulledFkInverseName(
	col: ManifestColumn,
	sourceAccessor: string,
	targetAccessor: string,
	tracker: PullNameTracker,
): string {
	const defaultInverse = col.unique
		? singularize(sourceAccessor)
		: sourceAccessor;
	const name = withSuffix(
		defaultInverse,
		reservedNamesOnTable(tracker, targetAccessor),
	);
	reserveRelationName(tracker, targetAccessor, name);
	return name;
}

function tableHeader(accessor: string, sqlName: string): string {
	const key = tsPropertyKey(accessor);
	if (sqlName === accessor) {
		return `  ${key}: table({`;
	}
	return `  ${key}: table("${escapeTsString(sqlName)}", {`;
}

/** `t.col` or `t["raw sql"]` when the tsName lookup falls back to a SQL name. */
function tColumnRef(tsNameBySql: Map<string, string>, sqlName: string): string {
	return tsMemberAccess("t", tsNameBySql.get(sqlName) ?? sqlName);
}

function whereField(ts: string, expr: string): string {
	return `${tsPropertyKey(ts)}: ${expr}`;
}

const POSTGIS_KINDS = new Set(["geometry", "geography", "point"]);

const SCHEMA_IMPORT_ORDER = [
	"defineSchema",
	"table",
	"id",
	"text",
	"bool",
	"int",
	"bigint",
	"serial",
	"timestamp",
	"uuid",
	"decimal",
	"json",
	"jsonb",
	"bytea",
	"citext",
	"enumType",
	"enumArray",
	"textArray",
	"intArray",
	"uuidArray",
	"real",
	"double",
	"date",
	"time",
	"interval",
	"inet",
	"cidr",
	"xml",
	"money",
	"int4Range",
	"int8Range",
	"numRange",
	"tsRange",
	"tstzRange",
	"dateRange",
	"fk",
	"foreignKey",
	"expr",
	"index",
	"unique",
	"primaryKey",
] as const;

export async function introspectPostgres(
	client: DatabaseClient,
	options: { schema?: string } = {},
): Promise<string> {
	const manifest = await introspectToManifest(client, options);
	return emitPostgresSchema(manifest);
}

/** Emit a `neoorm/schema` TS source from an introspected manifest. Exported for tests. */
export function emitPostgresSchema(manifest: Manifest): string {
	const usedBuilders = new Set<string>(["defineSchema", "table"]);
	const pluginColumnImports = new Set<string>();
	let needsPostgisSideEffect = false;
	const tracker = pullNameTracker(manifest);
	const tableBlocks: string[] = [];

	for (const table of Object.values(manifest.tables)) {
		const columnNaming = inferColumnNaming(
			table.columns.map((col) => col.sqlName),
		);
		const tsNameBySql = new Map(
			table.columns.map((col) => [col.sqlName, col.tsName]),
		);
		const blockLines: string[] = [
			tableHeader(table.accessor, table.sqlName),
		];

		for (const col of table.columns) {
			if (POSTGIS_KINDS.has(col.kind)) {
				needsPostgisSideEffect = true;
				pluginColumnImports.add(col.kind);
			}
			blockLines.push(
				`    ${emitPostgresColumn(col, table, manifest, columnNaming, usedBuilders, tracker)},`,
			);
		}

		const extras = emitTableExtras(
			table,
			tsNameBySql,
			usedBuilders,
			manifest,
			tracker,
		);
		blockLines.push(tableClose(columnNaming, extras));
		tableBlocks.push(blockLines.join("\n"));
	}

	const schemaImports = SCHEMA_IMPORT_ORDER.filter((name) =>
		usedBuilders.has(name),
	);
	const lines: string[] = [
		`import {`,
		...schemaImports.map((name) => `  ${name},`),
		`} from "neoorm/schema";`,
	];

	if (needsPostgisSideEffect) {
		lines.push(`import "neoorm/plugins/postgis";`);
	}

	if (pluginColumnImports.size > 0) {
		lines.push(
			`import { ${[...pluginColumnImports].sort().join(", ")} } from "neoorm/plugins/postgis";`,
		);
	}

	lines.push(``, `export const schema = defineSchema({`);
	lines.push(...tableBlocks);
	lines.push(`});`, ``);

	return lines.join("\n");
}

function emitPostgresColumn(
	col: ManifestColumn,
	table: ManifestTable,
	manifest: Manifest,
	columnNaming: ColumnNaming,
	usedBuilders: Set<string>,
	tracker: PullNameTracker,
): string {
	if (col.kind === "fk") {
		usedBuilders.add("fk");
		let def = `${tsPropertyKey(col.tsName)}: ${emitFkBuilder(col, table, manifest, tracker)}`;
		def += emitColumnModifiers(col, table, { skipNotNullIfPrimary: true });
		return appendMapModifier(def, col.tsName, col.sqlName, columnNaming);
	}

	if (col.kind === "id") {
		usedBuilders.add("id");
		let def = `${tsPropertyKey(col.tsName)}: id()`;
		def += emitColumnModifiers(col, table, {
			skipPrimary: true,
			skipNotNull: true,
		});
		return appendMapModifier(def, col.tsName, col.sqlName, columnNaming);
	}

	const call = emitScalarBuilder(col, usedBuilders);
	let def = `${tsPropertyKey(col.tsName)}: ${call}`;
	def += emitColumnModifiers(col, table, {
		skipNotNullIfPrimary: true,
		skipNotNull: col.kind === "serial",
	});
	return appendMapModifier(def, col.tsName, col.sqlName, columnNaming);
}

function emitScalarBuilder(
	col: ManifestColumn,
	usedBuilders: Set<string>,
): string {
	if (col.kind === "uuid") {
		usedBuilders.add("uuid");
		return col.typeOptions?.version === 4
			? "uuid({ version: 4 })"
			: "uuid()";
	}

	if (col.kind === "enum") {
		usedBuilders.add("enumType");
		const values =
			(col.typeOptions?.values as readonly string[] | undefined) ?? [];
		const quoted = values.map((value) => `"${escapeTsString(value)}"`);
		const nativeName =
			col.typeOptions?.nativeTypeName ?? col.typeOptions?.name;
		const nameArg =
			typeof nativeName === "string"
				? `, { name: "${escapeTsString(nativeName)}" }`
				: "";
		return `enumType([${quoted.join(", ")}]${nameArg})`;
	}

	if (col.kind === "enumArray") {
		usedBuilders.add("enumArray");
		const values =
			(col.typeOptions?.values as readonly string[] | undefined) ?? [];
		const quoted = values.map((value) => `"${escapeTsString(value)}"`);
		const nativeName =
			col.typeOptions?.nativeTypeName ?? col.typeOptions?.name;
		const nameArg =
			typeof nativeName === "string"
				? `, { name: "${escapeTsString(nativeName)}" }`
				: "";
		return `enumArray([${quoted.join(", ")}]${nameArg})`;
	}

	if (col.kind === "decimal") {
		usedBuilders.add("decimal");
		const precision = col.typeOptions?.precision;
		const scale = col.typeOptions?.scale;
		if (typeof precision === "number" && typeof scale === "number") {
			return `decimal({ precision: ${precision}, scale: ${scale} })`;
		}
		if (typeof precision === "number") {
			return `decimal({ precision: ${precision} })`;
		}
		return "decimal()";
	}

	if (col.kind === "text") {
		usedBuilders.add("text");
		const maxLength = col.typeOptions?.maxLength;
		if (typeof maxLength === "number") {
			return `text({ maxLength: ${maxLength} })`;
		}
		return "text()";
	}

	usedBuilders.add(col.kind);
	return `${col.kind}()`;
}

function emitFkBuilder(
	col: ManifestColumn,
	table: ManifestTable,
	manifest: Manifest,
	tracker: PullNameTracker,
): string {
	const targetRef = resolveFkAccessorTarget(col, manifest);
	const relName = inferFkAs(col.tsName);
	const relationName = pulledFkRelationName(col, table, manifest, tracker);
	let def = `fk("${escapeTsString(targetRef)}")`;
	if (relationName !== relName) {
		def += `.as("${escapeTsString(relationName)}")`;
	}
	const defaultInverse = col.unique
		? singularize(table.accessor)
		: table.accessor;
	if (col.fkInverse && col.fkInverse !== defaultInverse) {
		def += `.inverse("${escapeTsString(col.fkInverse)}")`;
		return def;
	}
	const targetAccessor = fkTargetAccessor(col, manifest);
	if (manifest.tables[targetAccessor]) {
		// Reserve the default inverse name on the target table and emit an
		// explicit `.inverse()` when the default is taken there (e.g. a second
		// fk to the same target, or a column carrying the accessor's name)
		const inverseName = pulledFkInverseName(
			col,
			table.accessor,
			targetAccessor,
			tracker,
		);
		if (inverseName !== defaultInverse) {
			def += `.inverse("${escapeTsString(inverseName)}")`;
		}
	}
	return def;
}

function emitColumnModifiers(
	col: ManifestColumn,
	table: ManifestTable,
	options: {
		skipPrimary?: boolean;
		skipNotNull?: boolean;
		skipNotNullIfPrimary?: boolean;
	} = {},
): string {
	let def = "";
	const solePrimary =
		col.primary && table.primaryKey.length === 1 && col.kind !== "id";
	if (!options.skipPrimary && solePrimary) {
		def += ".primary()";
	}
	const skipNotNull =
		options.skipNotNull || (options.skipNotNullIfPrimary && solePrimary);
	if (!skipNotNull && !col.nullable) {
		def += ".notNull()";
	}
	if (col.unique) {
		def += ".unique()";
	}
	if (col.onDelete && col.onDelete !== "no action") {
		def += `.onDelete("${escapeTsString(col.onDelete)}")`;
	}
	if (col.onUpdate && col.onUpdate !== "no action") {
		def += `.onUpdate("${escapeTsString(col.onUpdate)}")`;
	}
	if (col.deferrable) {
		def += `.deferrable("${escapeTsString(col.deferrable)}")`;
	}
	if (col.defaultNow) {
		def += ".defaultNow()";
	} else if (col.defaultValue !== undefined) {
		def += `.default(${formatTsValue(col.kind, col.defaultValue)})`;
	}
	if (col.checkExpression) {
		def += `.check("${escapeTsString(col.checkExpression)}")`;
	}
	return def;
}

function formatTsValue(kind: string, value: unknown): string {
	if (kind === "bigint") {
		const raw =
			typeof value === "bigint" ? value.toString() : String(value);
		if (/^-?\d+$/.test(raw)) {
			return `${raw}n`;
		}
	}
	if (kind === "json" || kind === "jsonb") {
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		return `"${escapeTsString(value)}"`;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value === null) {
		return "null";
	}
	if (typeof value === "bigint") {
		return `${value}n`;
	}
	return JSON.stringify(value);
}

type ParsedIndexPredicate =
	| { kind: "and"; items: ParsedIndexPredicate[] }
	| { kind: "or"; items: ParsedIndexPredicate[] }
	| { kind: "not"; item: ParsedIndexPredicate }
	| { kind: "col"; ts: string; expr: string; ops?: Record<string, string> };

function stripOuterParens(sql: string): string {
	let text = sql.trim();
	for (;;) {
		if (!text.startsWith("(") || !text.endsWith(")")) return text;
		let depth = 0;
		let balanced = true;
		let inStr = false;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (inStr) {
				if (ch === "'") {
					if (text[i + 1] === "'") {
						i++;
					} else {
						inStr = false;
					}
				}
				continue;
			}
			if (ch === "'") {
				inStr = true;
			} else if (ch === "(") {
				depth++;
			} else if (ch === ")") {
				depth--;
				if (depth === 0 && i !== text.length - 1) {
					balanced = false;
					break;
				}
			}
		}
		if (!balanced || depth !== 0) return text;
		text = text.slice(1, -1).trim();
	}
}

function splitTopLevel(
	sql: string,
	keyword: "AND" | "OR",
): string[] | undefined {
	const parts: string[] = [];
	let depth = 0;
	let inStr = false;
	let current = "";
	const upper = sql.toUpperCase();
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i];
		if (inStr) {
			current += ch;
			if (ch === "'") {
				if (sql[i + 1] === "'") {
					current += "'";
					i += 2;
					continue;
				}
				inStr = false;
			}
			i++;
			continue;
		}
		if (ch === "'") {
			inStr = true;
			current += ch;
			i++;
			continue;
		}
		if (ch === "(") {
			depth++;
			current += ch;
			i++;
			continue;
		}
		if (ch === ")") {
			depth--;
			current += ch;
			i++;
			continue;
		}
		if (depth === 0) {
			const rest = upper.slice(i);
			const match = rest.match(/^(AND|OR)\b/);
			if (match?.[1] === keyword) {
				const before = sql[i - 1];
				if (
					before === undefined ||
					/\s/.test(before) ||
					before === "(" ||
					before === ")"
				) {
					parts.push(current);
					current = "";
					i += keyword.length;
					continue;
				}
			}
		}
		current += ch;
		i++;
	}
	if (inStr || depth !== 0) return undefined;
	parts.push(current);
	if (parts.length <= 1) return undefined;
	return parts;
}

function parseIndexLiteralValue(
	valueSql: string,
): { ok: true; ts: string } | { ok: false } {
	const text = valueSql.trim();
	if (text === "true" || text === "false") {
		return { ok: true, ts: text };
	}
	if (/^-?\d+(\.\d+)?$/.test(text)) {
		return { ok: true, ts: text };
	}
	if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
		return {
			ok: true,
			ts: `"${escapeTsString(text.slice(1, -1).replace(/''/g, "'"))}"`,
		};
	}
	if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
		return { ok: true, ts: `"${escapeTsString(text.slice(1, -1))}"` };
	}
	return { ok: false };
}

function unescapeLikePattern(pattern: string): string | undefined {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			const next = pattern[i + 1];
			if (next === "%" || next === "_" || next === "\\") {
				out += next;
				i++;
				continue;
			}
			return undefined;
		}
		if (ch === "%" || ch === "_") return undefined;
		out += ch;
	}
	return out;
}

function likePatternToOp(
	pattern: string,
): { op: "contains" | "startsWith" | "endsWith"; value: string } | undefined {
	const starts = pattern.startsWith("%");
	const ends = pattern.endsWith("%");
	const inner = pattern.slice(
		starts ? 1 : 0,
		ends ? pattern.length - 1 : pattern.length,
	);
	if (inner.includes("%")) return undefined;
	const value = unescapeLikePattern(inner);
	if (value === undefined) return undefined;
	if (starts && ends) return { op: "contains", value };
	if (ends) return { op: "startsWith", value };
	if (starts) return { op: "endsWith", value };
	return undefined;
}

const INDEX_ATOM_COL = String.raw`(?:"(?<q1>[^"]+)"|(?<q2>[A-Za-z_][\w]*))`;

function parseIndexAtom(
	atom: string,
	tsNameBySql: Map<string, string>,
): ParsedIndexPredicate | undefined {
	const text = stripOuterParens(atom);
	const notMatch = text.match(/^NOT\b\s*([\s\S]*)$/i);
	if (notMatch?.[1]) {
		const inner = parseIndexConjunction(notMatch[1], tsNameBySql);
		if (!inner) return undefined;
		return { kind: "not", item: inner };
	}
	const tsOf = (sql: string | undefined): string | undefined => {
		if (sql === undefined) return undefined;
		return tsNameBySql.get(sql) ?? sql;
	};

	let match = text.match(
		new RegExp(`^${INDEX_ATOM_COL}\\s+IS\\s+NOT\\s+NULL$`, "i"),
	);
	if (match) {
		const ts = tsOf(match.groups?.q1 ?? match.groups?.q2);
		if (!ts) return undefined;
		return {
			kind: "col",
			ts,
			expr: "{ isNotNull: true }",
			ops: { isNotNull: "true" },
		};
	}
	match = text.match(new RegExp(`^${INDEX_ATOM_COL}\\s+IS\\s+NULL$`, "i"));
	if (match) {
		const ts = tsOf(match.groups?.q1 ?? match.groups?.q2);
		if (!ts) return undefined;
		return { kind: "col", ts, expr: "null" };
	}
	match = text.match(
		new RegExp(
			`^LOWER\\(${INDEX_ATOM_COL}\\)\\s*=\\s*LOWER\\((?<lit>[\\s\\S]+)\\)$`,
			"i",
		),
	);
	if (match) {
		const ts = tsOf(match.groups?.q1 ?? match.groups?.q2);
		const lit = match.groups?.lit
			? parseIndexLiteralValue(match.groups.lit)
			: { ok: false as const };
		if (!ts || !lit.ok) return undefined;
		return {
			kind: "col",
			ts,
			expr: `{ equals: ${lit.ts}, mode: "insensitive" }`,
			ops: { equals: lit.ts, mode: '"insensitive"' },
		};
	}
	match = text.match(
		new RegExp(
			`^LOWER\\(${INDEX_ATOM_COL}\\)\\s+LIKE\\s+LOWER\\((?<lit>[\\s\\S]+?)\\)(?:\\s+ESCAPE\\s+'(?:\\\\|\\\\\\\\)')?$`,
			"i",
		),
	);
	if (match) {
		const ts = tsOf(match.groups?.q1 ?? match.groups?.q2);
		const lit = match.groups?.lit
			? parseIndexLiteralValue(match.groups.lit)
			: { ok: false as const };
		if (!ts || !lit.ok) return undefined;
		const raw = match.groups?.lit?.trim() ?? "";
		const inner = raw.startsWith("'")
			? raw.slice(1, -1).replace(/''/g, "'")
			: undefined;
		if (inner === undefined) return undefined;
		const mapped = likePatternToOp(inner);
		if (!mapped) return undefined;
		return {
			kind: "col",
			ts,
			expr: `{ ${mapped.op}: "${escapeTsString(mapped.value)}", mode: "insensitive" }`,
			ops: {
				[mapped.op]: `"${escapeTsString(mapped.value)}"`,
				mode: '"insensitive"',
			},
		};
	}
	match = text.match(
		new RegExp(
			`^${INDEX_ATOM_COL}\\s+NOT\\s+IN\\s*\\((?<list>[\\s\\S]+)\\)$`,
			"i",
		),
	);
	if (match) {
		const ts = tsOf(match.groups?.q1 ?? match.groups?.q2);
		const list = parseIndexLiteralList(match.groups?.list ?? "");
		if (!ts || !list) return undefined;
		return {
			kind: "col",
			ts,
			expr: `{ notIn: [${list.join(", ")}] }`,
			ops: { notIn: `[${list.join(", ")}]` },
		};
	}
	match = text.match(
		new RegExp(
			`^${INDEX_ATOM_COL}\\s+IN\\s*\\((?<list>[\\s\\S]+)\\)$`,
			"i",
		),
	);
	if (match) {
		const ts = tsOf(match.groups?.q1 ?? match.groups?.q2);
		const list = parseIndexLiteralList(match.groups?.list ?? "");
		if (!ts || !list) return undefined;
		return {
			kind: "col",
			ts,
			expr: `{ in: [${list.join(", ")}] }`,
			ops: { in: `[${list.join(", ")}]` },
		};
	}
	match = text.match(
		new RegExp(
			`^${INDEX_ATOM_COL}\\s+LIKE\\s+(?<lit>'(?:[^']|'')*')\\s*(?:ESCAPE\\s+'(?:\\\\|\\\\\\\\)')?$`,
			"i",
		),
	);
	if (match) {
		const ts = tsOf(match.groups?.q1 ?? match.groups?.q2);
		const lit = match.groups?.lit
			? parseIndexLiteralValue(match.groups.lit)
			: { ok: false as const };
		if (!ts || !lit.ok) return undefined;
		const raw = (match.groups?.lit ?? "").slice(1, -1).replace(/''/g, "'");
		const mapped = likePatternToOp(raw);
		if (!mapped) return undefined;
		return {
			kind: "col",
			ts,
			expr: `{ ${mapped.op}: "${escapeTsString(mapped.value)}" }`,
			ops: { [mapped.op]: `"${escapeTsString(mapped.value)}"` },
		};
	}
	match = text.match(
		new RegExp(
			`^${INDEX_ATOM_COL}\\s*(?<op>~\\*|~)\\s*(?<lit>'(?:[^']|'')*')$`,
			"i",
		),
	);
	if (match) {
		const ts = tsOf(match.groups?.q1 ?? match.groups?.q2);
		const lit = match.groups?.lit
			? parseIndexLiteralValue(match.groups.lit)
			: { ok: false as const };
		if (!ts || !lit.ok) return undefined;
		const insensitive = match.groups?.op === "~*";
		return {
			kind: "col",
			ts,
			expr: insensitive
				? `{ search: ${lit.ts}, mode: "insensitive" }`
				: `{ search: ${lit.ts} }`,
			ops: insensitive
				? { search: lit.ts, mode: '"insensitive"' }
				: { search: lit.ts },
		};
	}
	match = text.match(
		new RegExp(
			`^${INDEX_ATOM_COL}\\s+REGEXP\\s+(?<lit>'(?:[^']|'')*')$`,
			"i",
		),
	);
	if (match) {
		const ts = tsOf(match.groups?.q1 ?? match.groups?.q2);
		const lit = match.groups?.lit
			? parseIndexLiteralValue(match.groups.lit)
			: { ok: false as const };
		if (!ts || !lit.ok) return undefined;
		return {
			kind: "col",
			ts,
			expr: `{ search: ${lit.ts} }`,
			ops: { search: lit.ts },
		};
	}
	match = text.match(
		new RegExp(
			`^regexp_i\\((?<lit>'(?:[^']|'')*')\\s*,\\s*${INDEX_ATOM_COL}\\)$`,
			"i",
		),
	);
	if (match) {
		const allGroups = match.groups ?? {};
		const colSql = allGroups.q1 ?? allGroups.q2;
		const ts = tsOf(colSql);
		const lit = match.groups?.lit
			? parseIndexLiteralValue(match.groups.lit)
			: { ok: false as const };
		if (!ts || !lit.ok) return undefined;
		return {
			kind: "col",
			ts,
			expr: `{ search: ${lit.ts}, mode: "insensitive" }`,
			ops: { search: lit.ts, mode: '"insensitive"' },
		};
	}
	match = text.match(
		new RegExp(
			`^${INDEX_ATOM_COL}\\s*(?<op>=|<>|!=|>=|<=|>|<)\\s*(?<lit>[\\s\\S]+)$`,
			"i",
		),
	);
	if (match) {
		const ts = tsOf(match.groups?.q1 ?? match.groups?.q2);
		const lit = match.groups?.lit
			? parseIndexLiteralValue(match.groups.lit)
			: { ok: false as const };
		if (!ts || !lit.ok) return undefined;
		const op = match.groups?.op ?? "=";
		if (op === "=") {
			if (lit.ts === "1" || lit.ts === "0") {
				return {
					kind: "col",
					ts,
					expr: lit.ts === "1" ? "true" : "false",
				};
			}
			if (lit.ts === "true" || lit.ts === "false") {
				return { kind: "col", ts, expr: lit.ts };
			}
			return { kind: "col", ts, expr: lit.ts };
		}
		if (op === "<>" || op === "!=") {
			return {
				kind: "not",
				item: { kind: "col", ts, expr: lit.ts },
			};
		}
		const opName =
			op === ">" ? "gt" : op === ">=" ? "gte" : op === "<" ? "lt" : "lte";
		return {
			kind: "col",
			ts,
			expr: `{ ${opName}: ${lit.ts} }`,
			ops: { [opName]: lit.ts },
		};
	}
	return undefined;
}

function parseIndexLiteralList(listSql: string): string[] | undefined {
	const items: string[] = [];
	let depth = 0;
	let inStr = false;
	let current = "";
	for (let i = 0; i < listSql.length; i++) {
		const ch = listSql[i];
		if (inStr) {
			current += ch;
			if (ch === "'") {
				if (listSql[i + 1] === "'") {
					current += "'";
					i++;
				} else {
					inStr = false;
				}
			}
			continue;
		}
		if (ch === "'") {
			inStr = true;
			current += ch;
			continue;
		}
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			const parsed = parseIndexLiteralValue(current);
			if (!parsed.ok) return undefined;
			if (parsed.ts === "1" || parsed.ts === "0") return undefined;
			items.push(parsed.ts);
			current = "";
			continue;
		}
		current += ch;
	}
	if (inStr || depth !== 0) return undefined;
	if (current.trim().length > 0) {
		const parsed = parseIndexLiteralValue(current);
		if (!parsed.ok) return undefined;
		if (parsed.ts === "1" || parsed.ts === "0") return undefined;
		items.push(parsed.ts);
	}
	if (items.length === 0) return undefined;
	return items;
}

function parseIndexConjunction(
	sql: string,
	tsNameBySql: Map<string, string>,
): ParsedIndexPredicate | undefined {
	const text = stripOuterParens(sql);
	const orBranches = splitTopLevel(text, "OR");
	if (orBranches) {
		const items: ParsedIndexPredicate[] = [];
		for (const branch of orBranches) {
			const parsed = parseIndexConjunction(branch, tsNameBySql);
			if (!parsed) return undefined;
			items.push(parsed);
		}
		return { kind: "or", items };
	}
	const andBranches = splitTopLevel(text, "AND");
	if (andBranches) {
		const items: ParsedIndexPredicate[] = [];
		for (const branch of andBranches) {
			const parsed = parseIndexConjunction(branch, tsNameBySql);
			if (!parsed) return undefined;
			items.push(parsed);
		}
		return { kind: "and", items };
	}
	return parseIndexAtom(text, tsNameBySql);
}

function renderIndexPredicate(node: ParsedIndexPredicate): string | undefined {
	switch (node.kind) {
		case "and": {
			const bodies = conjunctBodies(node.items);
			if (!bodies) return undefined;
			if (bodies.length === 1) return bodies[0];
			return `AND: [${bodies.map((body) => `{ ${body} }`).join(", ")}]`;
		}
		case "or": {
			const elements: string[] = [];
			for (const item of node.items) {
				if (item.kind === "and") {
					const bodies = conjunctBodies(item.items);
					if (!bodies) return undefined;
					for (const body of bodies) elements.push(`{ ${body} }`);
					continue;
				}
				const inner = renderIndexPredicate(item);
				if (!inner) return undefined;
				elements.push(`{ ${inner} }`);
			}
			return `OR: [${elements.join(", ")}]`;
		}
		case "not": {
			const inner = renderIndexPredicate(node.item);
			if (!inner) return undefined;
			return `NOT: { ${inner} }`;
		}
		case "col":
			return whereField(node.ts, node.expr);
		default: {
			const exhaustive: never = node;
			return exhaustive;
		}
	}
}

/** Group an AND level into where-object bodies, merging same-column operators. */
function conjunctBodies(items: ParsedIndexPredicate[]): string[] | undefined {
	const bodies: string[] = [];
	const pending = new Map<
		string,
		{ expr: string; ops?: Record<string, string> }
	>();
	const order: string[] = [];
	const flush = (): void => {
		if (order.length === 0) return;
		bodies.push(
			order
				.map((ts) => whereField(ts, pending.get(ts)?.expr ?? ""))
				.join(", "),
		);
		pending.clear();
		order.length = 0;
	};
	for (const item of items) {
		if (item.kind === "col") {
			const incomingOps: Record<string, string> =
				item.ops ??
				(item.expr === "null"
					? { equals: "null" }
					: { equals: item.expr });
			const existing = pending.get(item.ts);
			if (!existing) {
				pending.set(
					item.ts,
					item.ops
						? { expr: item.expr, ops: incomingOps }
						: { expr: item.expr, ops: incomingOps },
				);
				order.push(item.ts);
				continue;
			}
			if (!existing.ops) return undefined;
			const merged: Record<string, string> = { ...existing.ops };
			for (const [op, val] of Object.entries(incomingOps)) {
				if (op in merged) return undefined;
				merged[op] = val;
			}
			pending.set(item.ts, {
				expr: `{ ${Object.entries(merged)
					.map(([op, val]) => `${op}: ${val}`)
					.join(", ")} }`,
				ops: merged,
			});
			continue;
		}
		flush();
		const rendered = renderIndexPredicate(item);
		if (!rendered) return undefined;
		bodies.push(rendered);
	}
	flush();
	return bodies;
}

export function parseIndexWhere(
	whereSql: string,
	tsNameBySql: Map<string, string>,
): string | undefined {
	const parsed = parseIndexConjunction(whereSql, tsNameBySql);
	if (!parsed) return undefined;
	if (parsed.kind === "col") {
		return `.where({ ${whereField(parsed.ts, parsed.expr)} })`;
	}
	if (parsed.kind === "and") {
		const bodies = conjunctBodies(parsed.items);
		if (!bodies || bodies.length === 0) return undefined;
		if (bodies.length === 1) {
			return `.where({ ${bodies[0]} })`;
		}
		return `.where({ AND: [${bodies.map((body) => `{ ${body} }`).join(", ")}] })`;
	}
	const rendered = renderIndexPredicate(parsed);
	if (!rendered) return undefined;
	return `.where({ ${rendered} })`;
}

function emitTableExtras(
	table: ManifestTable,
	tsNameBySql: Map<string, string>,
	usedBuilders?: Set<string>,
	manifest?: Manifest,
	tracker?: PullNameTracker,
): string[] {
	const extras: string[] = [];
	for (const index of table.indexes) {
		const builder = index.unique ? "unique" : "index";
		usedBuilders?.add(builder);
		const keys = manifestIndexKeys(index);
		const cols = keys
			.map((key) => {
				if (key.expr) {
					usedBuilders?.add("expr");
					return `expr("${escapeTsString(key.expr)}")`;
				}
				const sqlName = key.sqlName ?? "";
				return tColumnRef(tsNameBySql, sqlName);
			})
			.join(", ");
		let extra = `${builder}(${cols})`;
		if (index.using && index.using !== "btree") {
			extra += `.using("${escapeTsString(index.using)}")`;
		}
		if (index.opclass) {
			extra += `.ops("${escapeTsString(index.opclass)}")`;
		}
		if (index.using === "bloom" && index.with) {
			const withParts: string[] = [];
			if (index.with.length !== undefined) {
				withParts.push(`length: ${index.with.length}`);
			}
			if (index.with.cols !== undefined) {
				withParts.push(`cols: [${index.with.cols.join(", ")}]`);
			}
			if (withParts.length > 0) {
				extra += `.with({ ${withParts.join(", ")} })`;
			}
		}
		if (index.whereSql) {
			const where = parseIndexWhere(index.whereSql, tsNameBySql);
			if (where) extra += where;
		}
		extras.push(`    ${extra},`);
	}
	if (table.primaryKey.length > 1) {
		usedBuilders?.add("primaryKey");
		extras.push(
			`    primaryKey(${table.primaryKey
				.map((sqlName) => tColumnRef(tsNameBySql, sqlName))
				.join(", ")}),`,
		);
	}
	for (const fk of table.foreignKeys ?? []) {
		usedBuilders?.add("foreignKey");
		const target = manifest
			? Object.values(manifest.tables).find(
					(item) => item.sqlName === fk.targetTable,
				)
			: undefined;
		const localCols = fk.columns
			.map((sqlName) => tColumnRef(tsNameBySql, sqlName))
			.join(", ");
		const targetCols = fk.targetColumns
			.map((sqlName) => {
				const ts =
					target?.columns.find((col) => col.sqlName === sqlName)
						?.tsName ?? sqlName;
				return `"${escapeTsString(ts)}"`;
			})
			.join(", ");
		const accessor = target?.accessor ?? fk.targetTable;
		const firstLocal = tsNameBySql.get(fk.columns[0] ?? "") ?? "ref";
		// Composite FK constraints are emitted as a `foreignKey()` extra whose
		// relation name and inverse compete with column names and other picked
		// relations on both tables — same resolver as column-level fks.
		let asName = inferFkAs(firstLocal);
		let inverseName = table.accessor;
		if (tracker && manifest) {
			const usedOnSource = reservedNamesOnTable(tracker, table.accessor);
			if (usedOnSource.has(asName)) {
				const fallbackBase =
					asName === firstLocal && target?.accessor
						? singularize(target.accessor)
						: "";
				asName = withSuffix(
					fallbackBase !== "" ? fallbackBase : asName,
					usedOnSource,
				);
			}
			reserveRelationName(tracker, table.accessor, asName);
			const targetKey = target?.accessor ?? fk.targetTable;
			if (targetKey) {
				inverseName = withSuffix(
					table.accessor,
					reservedNamesOnTable(tracker, targetKey),
				);
				reserveRelationName(tracker, targetKey, inverseName);
			}
		}
		let extra = `foreignKey(${localCols}).references("${escapeTsString(accessor)}", ${targetCols}).as("${escapeTsString(asName)}").inverse("${escapeTsString(inverseName)}")`;
		if (fk.onDelete && fk.onDelete !== "no action") {
			extra += `.onDelete("${escapeTsString(fk.onDelete)}")`;
		}
		if (fk.onUpdate && fk.onUpdate !== "no action") {
			extra += `.onUpdate("${escapeTsString(fk.onUpdate)}")`;
		}
		if (fk.deferrable) {
			extra += `.deferrable("${escapeTsString(fk.deferrable)}")`;
		}
		const defaultName = `${table.sqlName}_${fk.columns.join("_")}_fkey`;
		if (fk.name !== defaultName) {
			extra += `.map("${escapeTsString(fk.name)}")`;
		}
		extras.push(`    ${extra},`);
	}
	return extras;
}

function tableClose(columnNaming: ColumnNaming, extras: string[]): string {
	if (extras.length === 0) {
		if (columnNaming === "camelCase") {
			return `  }, { columnNaming: "camelCase" }),`;
		}
		return `  }),`;
	}

	const extrasBlock = extras.join("\n");
	if (columnNaming === "camelCase") {
		return `  }, {
    columnNaming: "camelCase",
    extras: (t) => [
${extrasBlock}
    ],
  }),`;
	}
	return `  }, (t) => [
${extrasBlock}
  ]),`;
}

function sqliteColumnBuilder(col: ManifestColumn): string {
	switch (col.kind) {
		case "id":
			return "id";
		case "serial":
			return "serial";
		case "int":
			return "int";
		case "bool":
			return "bool";
		case "timestamp":
			return "timestamp";
		case "decimal":
			return "decimal";
		case "jsonb":
			return "jsonb";
		case "json":
			return "json";
		case "bytea":
			return "bytea";
		case "real":
			return "real";
		case "double":
			return "double";
		case "date":
			return "date";
		case "time":
			return "time";
		case "interval":
			return "interval";
		case "inet":
			return "inet";
		case "cidr":
			return "cidr";
		case "xml":
			return "xml";
		case "money":
			return "money";
		case "uuid":
			return "uuid";
		case "textArray":
			return "textArray";
		case "intArray":
			return "intArray";
		case "uuidArray":
			return "uuidArray";
		default:
			return "text";
	}
}

function resolveFkAccessorTarget(
	col: ManifestColumn,
	manifest: Manifest,
): string {
	if (!col.fkTarget) {
		return "";
	}
	const dot = col.fkTarget.indexOf(".");
	if (dot === -1) {
		return col.fkTarget;
	}
	const sqlTable = col.fkTarget.slice(0, dot);
	const sqlColumn = col.fkTarget.slice(dot + 1);
	const targetTable = Object.values(manifest.tables).find(
		(table) => table.sqlName === sqlTable,
	);
	const accessor = targetTable?.accessor ?? sqlTable;
	const targetCol = targetTable?.columns.find(
		(c) => c.sqlName === sqlColumn || c.tsName === sqlColumn,
	);
	if (targetCol?.tsName === "id") {
		return accessor;
	}
	return `${accessor}.${targetCol?.tsName ?? sqlColumn}`;
}

function sqliteColumnDef(
	col: ManifestColumn,
	table: ManifestTable,
	manifest: Manifest,
	tracker: PullNameTracker,
): string {
	if (col.kind === "fk" && col.fkTarget) {
		const targetRef = resolveFkAccessorTarget(col, manifest);
		const relName = inferFkAs(col.tsName);
		const relationName = pulledFkRelationName(
			col,
			table,
			manifest,
			tracker,
		);
		let def = `fk("${escapeTsString(targetRef)}")`;
		if (relationName !== relName) {
			def += `.as("${escapeTsString(relationName)}")`;
		}
		const defaultInverse = col.unique
			? singularize(table.accessor)
			: table.accessor;
		if (col.fkInverse && col.fkInverse !== defaultInverse) {
			def += `.inverse("${escapeTsString(col.fkInverse)}")`;
		} else {
			const targetAccessor = fkTargetAccessor(col, manifest);
			if (manifest.tables[targetAccessor]) {
				const inverseName = pulledFkInverseName(
					col,
					table.accessor,
					targetAccessor,
					tracker,
				);
				if (inverseName !== defaultInverse) {
					def += `.inverse("${escapeTsString(inverseName)}")`;
				}
			}
		}
		if (col.onDelete) {
			def += `.onDelete("${escapeTsString(col.onDelete)}")`;
		}
		if (col.onUpdate) {
			def += `.onUpdate("${escapeTsString(col.onUpdate)}")`;
		}
		if (col.deferrable) {
			def += `.deferrable("${escapeTsString(col.deferrable)}")`;
		}
		if (col.primary) {
			def += ".primary()";
		} else if (!col.nullable) {
			def += ".notNull()";
		}
		return `${tsPropertyKey(col.tsName)}: ${def},`;
	}

	let def = `${tsPropertyKey(col.tsName)}: ${sqliteColumnBuilder(col)}()`;
	if (col.kind !== "id" && col.primary && table.primaryKey.length === 1) {
		def += ".primary()";
	}
	if (col.defaultNow) {
		def += ".defaultNow()";
	}
	if (col.unique) {
		def += ".unique()";
	}
	if (!col.nullable && !col.primary) {
		def += ".notNull()";
	}
	return `${def},`;
}

export async function introspectMysql(client: DatabaseClient): Promise<string> {
	const manifest = await introspectMysqlToManifest(client);
	return emitPostgresSchema(manifest);
}

/** Emit a `neoorm/schema` TS source from a SQLite-introspected manifest. Exported for tests. */
export function emitSqliteSchema(manifest: Manifest): string {
	const tracker = pullNameTracker(manifest);
	const tableBlocks: string[] = [];
	for (const table of Object.values(manifest.tables)) {
		const tsNameBySql = new Map(
			table.columns.map((col) => [col.sqlName, col.tsName]),
		);
		const lines: string[] = [tableHeader(table.accessor, table.sqlName)];
		for (const col of table.columns) {
			lines.push(`    ${sqliteColumnDef(col, table, manifest, tracker)}`);
		}

		const extras = emitTableExtras(
			table,
			tsNameBySql,
			undefined,
			manifest,
			tracker,
		);

		if (extras.length > 0) {
			lines.push(
				`  }, (t) => [
${extras.join("\n")}
  ]),`,
			);
		} else {
			lines.push(`  }),`);
		}
		tableBlocks.push(lines.join("\n"));
	}

	return [
		`import {`,
		`  defineSchema,`,
		`  table,`,
		`  id,`,
		`  text,`,
		`  bool,`,
		`  int,`,
		`  timestamp,`,
		`  decimal,`,
		`  jsonb,`,
		`  bytea,`,
		`  serial,`,
		`  fk,`,
		`  foreignKey,`,
		`  index,`,
		`  unique,`,
		`  primaryKey,`,
		`} from "neoorm/schema";`,
		``,
		`export const schema = defineSchema({`,
		...tableBlocks,
		`});`,
		``,
	].join("\n");
}

export async function introspectSqlite(
	client: DatabaseClient,
): Promise<string> {
	const manifest = await introspectSqliteToManifest(client);
	return emitSqliteSchema(manifest);
}

function inferColumnNaming(columnNames: string[]): ColumnNaming {
	const allCamelCase = columnNames.every(
		(sqlName) => toCamelCase(sqlName) === sqlName,
	);
	const needsSnakeCaseMap = columnNames.some(
		(sqlName) =>
			sqlName !== resolveSqlColumnName(toCamelCase(sqlName), "snakeCase"),
	);

	return allCamelCase && needsSnakeCaseMap ? "camelCase" : "snakeCase";
}

function appendMapModifier(
	def: string,
	tsName: string,
	sqlName: string,
	columnNaming: ColumnNaming,
): string {
	if (sqlName === resolveSqlColumnName(tsName, columnNaming)) {
		return def;
	}
	return `${def}.map("${escapeTsString(sqlName)}")`;
}
