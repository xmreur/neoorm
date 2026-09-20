export type StudioColumnMeta = {
	tsName: string;
	sqlName: string;
	kind: string;
	nullable: boolean;
	unique: boolean;
	primary: boolean;
	index: boolean;
	hidden: boolean;
	generated: boolean;
	defaultNow: boolean;
	updatedAt: boolean;
	defaultValue: unknown;
	checkExpression?: string;
	typeOptions: Record<string, unknown>;
	fkTarget?: string;
	fkAs?: string;
	fkInverse?: string;
	onDelete?: string;
	onUpdate?: string;
	uniqueGroups: string[][];
};

export type StudioRelationMeta = {
	name: string;
	targetTable: string;
	targetAccessor: string;
	cardinality: "one" | "many";
	inverse: string;
	fkColumn: string;
	fkSqlColumn: string;
	targetColumn: string;
	m2m: boolean;
};

export type StudioIndexMeta = {
	name: string;
	columns: readonly string[];
	unique: boolean;
	sqlName?: string;
	whereSql?: string;
	using?: string;
};

export type StudioTableMeta = {
	accessor: string;
	sqlName: string;
	schemaName?: string;
	columns: StudioColumnMeta[];
	relations: StudioRelationMeta[];
	indexes: StudioIndexMeta[];
	primaryKey: readonly string[];
	foreignKeys: {
		name: string;
		columns: readonly string[];
		targetTable: string;
		targetColumns: readonly string[];
		onDelete?: string;
		onUpdate?: string;
	}[];
	uniqueKeys: string[][];
	junction: boolean;
	mutable: boolean;
};

export type StudioMetaResponse = {
	provider?: string;
	pgSchema?: string;
	enumMode?: string;
	enumTypes: Record<string, { values: readonly string[] }>;
	extensions: string[];
	tables: Record<string, StudioTableMeta>;
	manyToMany: unknown[];
	metaSource: "schema" | "snapshot";
	readOnly: boolean;
	dialect: string;
};

export type StudioGraphResponse = {
	nodes: {
		accessor: string;
		sqlName: string;
		junction: boolean;
		columns: {
			tsName: string;
			kind: string;
			primary: boolean;
			hidden: boolean;
		}[];
	}[];
	edges: {
		from: string;
		to: string;
		label: string;
		cardinality: "one" | "many";
		m2m: boolean;
		through?: string;
	}[];
};

export type StudioErrorShape = {
	error: {
		code: string;
		message: string;
		tableAccessor?: string;
		columnTsName?: string;
		columnSqlName?: string;
		constraint?: string;
		detail?: string;
	};
};

export class StudioApiError extends Error {
	status: number;
	code: string;
	detail?: string;
	columnTsName?: string;

	constructor(status: number, body: StudioErrorShape) {
		super(body.error.message);
		this.name = "StudioApiError";
		this.status = status;
		this.code = body.error.code;
		this.detail = body.error.detail;
		this.columnTsName = body.error.columnTsName;
	}
}

function token(): string {
	return localStorage.getItem("neoorm-studio-token") ?? "";
}

export function setToken(value: string): void {
	if (value) localStorage.setItem("neoorm-studio-token", value);
	else localStorage.removeItem("neoorm-studio-token");
}

async function request(path: string, init?: RequestInit): Promise<Response> {
	const headers = new Headers(init?.headers);
	headers.set("Content-Type", "application/json");
	const t = token();
	if (t) headers.set("x-studio-token", t);
	return fetch(path, { ...init, headers });
}

async function parse<T>(res: Response): Promise<T> {
	if (!res.ok) {
		let body: StudioErrorShape = {
			error: {
				code: "http_error",
				message: `Request failed (${res.status})`,
			},
		};
		try {
			body = (await res.json()) as StudioErrorShape;
		} catch {
			// keep default
		}
		throw new StudioApiError(res.status, body);
	}
	return (await res.json()) as T;
}

export const api = {
	meta: () => request("/api/meta").then((r) => parse<StudioMetaResponse>(r)),
	rows: (accessor: string, params: Record<string, string>) =>
		request(
			`/api/tables/${encodeURIComponent(accessor)}/rows?${new URLSearchParams(params).toString()}`,
		).then((r) =>
			parse<{
				rows: Record<string, unknown>[];
				total: number;
				take: number;
				skip: number;
			}>(r),
		),
	create: (accessor: string, body: unknown) =>
		request(`/api/tables/${encodeURIComponent(accessor)}/rows`, {
			method: "POST",
			body: JSON.stringify(body),
		}).then((r) =>
			parse<{ row?: Record<string, unknown>; count?: number }>(r),
		),
	update: (accessor: string, body: unknown) =>
		request(`/api/tables/${encodeURIComponent(accessor)}/rows`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}).then((r) =>
			parse<{ row?: Record<string, unknown>; count?: number }>(r),
		),
	remove: (accessor: string, body: unknown) =>
		request(`/api/tables/${encodeURIComponent(accessor)}/rows`, {
			method: "DELETE",
			body: JSON.stringify(body),
		}).then((r) =>
			parse<{ row?: Record<string, unknown>; count?: number }>(r),
		),
	query: (body: unknown) =>
		request("/api/query", {
			method: "POST",
			body: JSON.stringify(body),
		}).then((r) =>
			parse<{
				rows?: Record<string, unknown>[];
				row?: Record<string, unknown> | null;
				result?: unknown;
				items?: Record<string, unknown>[];
				nextCursor?: unknown;
				prevCursor?: unknown;
				hasMore?: boolean;
				hasPrevious?: boolean;
			}>(r),
		),
	sql: (body: unknown) =>
		request("/api/sql", {
			method: "POST",
			body: JSON.stringify(body),
		}).then((r) =>
			parse<{ rows: Record<string, unknown>[]; rowCount: number }>(r),
		),
	graph: () =>
		request("/api/graph").then((r) => parse<StudioGraphResponse>(r)),
	migrateStatus: () =>
		request("/api/migrate/status").then((r) =>
			parse<
				| { available: false; reason: string }
				| {
						available: true;
						migrationsDir: string;
						applied: {
							name: string;
							appliedAt: string;
							checksum: string | null;
						}[];
						pending: string[];
						orphanApplied: string[];
				  }
			>(r),
		),
	importRows: (body: unknown) =>
		request("/api/import", {
			method: "POST",
			body: JSON.stringify(body),
		}).then((r) => parse<{ count: number }>(r)),
	exportUrl: (accessor: string, params: Record<string, string>) => {
		const t = token();
		const all = { ...params, ...(t ? { token: t } : {}) };
		return `/api/export?accessor=${encodeURIComponent(accessor)}&${new URLSearchParams(all).toString()}`;
	},
};

/** True for `{__neoorm: ...}` markers produced by the server codec. */
export function isMarker(
	value: unknown,
): value is { __neoorm: string; value?: string; base64?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"__neoorm" in (value as Record<string, unknown>)
	);
}

function markerLabel(value: {
	__neoorm: string;
	value?: string;
	base64?: string;
}): string {
	if (value.__neoorm === "bigint") return value.value ?? "";
	if (value.__neoorm === "date") {
		const d = new Date(value.value ?? "");
		return Number.isNaN(d.getTime())
			? (value.value ?? "")
			: d.toLocaleString();
	}
	if (value.__neoorm === "bytes") {
		const size = Math.floor(((value.base64 ?? "").length * 3) / 4);
		return `<${size} bytes>`;
	}
	return JSON.stringify(value);
}

/** Short human-readable preview for any cell value. */
export function formatCell(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (isMarker(value)) return markerLabel(value);
	if (typeof value === "string") return value;
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	)
		return String(value);
	const json = JSON.stringify(value);
	if (json === undefined) return "";
	return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

/** Full (untruncated) text for detail views and copy. */
export function fullCellText(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (isMarker(value)) {
		if (value.__neoorm === "bytes") return `base64:${value.base64 ?? ""}`;
		return value.value ?? "";
	}
	if (typeof value === "string") return value;
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	)
		return String(value);
	return JSON.stringify(value, null, 2) ?? "";
}

/** Editable text for a cell: markers become plain values, objects become JSON. */
export function editText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (isMarker(value)) {
		if (value.__neoorm === "bytes") return value.base64 ?? "";
		return value.value ?? "";
	}
	if (typeof value === "string") return value;
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	)
		return String(value);
	return JSON.stringify(value, null, 2) ?? "";
}

export function enumValues(column: StudioColumnMeta): string[] | null {
	const raw = column.typeOptions.values;
	if (Array.isArray(raw))
		return raw.filter((v): v is string => typeof v === "string");
	return null;
}

export function isNumericKind(kind: string): boolean {
	return (
		kind === "int" ||
		kind === "bigint" ||
		kind === "serial" ||
		kind === "real" ||
		kind === "double" ||
		kind === "decimal" ||
		kind === "numeric" ||
		kind === "money"
	);
}

export function isTextKind(kind: string): boolean {
	return (
		kind === "text" ||
		kind === "citext" ||
		kind === "id" ||
		kind === "uuid" ||
		kind === "xml" ||
		kind === "inet" ||
		kind === "cidr" ||
		kind === "enum"
	);
}

export function isJsonKind(kind: string): boolean {
	return kind === "json" || kind === "jsonb";
}

export function isGeoKind(kind: string): boolean {
	return kind === "geometry" || kind === "geography" || kind === "point";
}

/** Resolve the FK column on the *target* table for an inverse/to-many relation. */
export function inverseFkColumn(
	meta: StudioMetaResponse,
	relation: StudioRelationMeta,
): string | null {
	const target = meta.tables[relation.targetAccessor];
	const inverse = target?.relations.find((r) => r.name === relation.inverse);
	return inverse?.fkColumn ?? null;
}

/** TS name on `table` for a SQL column name (falls back to the SQL name). */
export function tsForSql(table: StudioTableMeta, sqlName: string): string {
	return (
		table.columns.find((c) => c.sqlName === sqlName)?.tsName ??
		table.columns.find((c) => c.tsName === sqlName)?.tsName ??
		sqlName
	);
}

/** Build a navigation filter on the target table for `row` via `relation`. */
export function navigationWhere(
	meta: StudioMetaResponse,
	source: StudioTableMeta,
	row: Record<string, unknown>,
	relation: StudioRelationMeta,
): { accessor: string; where: Record<string, unknown> } | null {
	const target = meta.tables[relation.targetAccessor];
	if (!target) return null;
	if (relation.m2m) {
		const pk = source.uniqueKeys[0]?.[0];
		const value = pk ? row[pk] : undefined;
		if (!pk || value === undefined || value === null) return null;
		return {
			accessor: target.accessor,
			where: { [relation.inverse]: { some: { [pk]: value } } },
		};
	}
	if (relation.cardinality === "one") {
		const localTs = relation.fkColumn;
		const value = row[localTs];
		if (value === undefined || value === null) return null;
		const targetTs = tsForSql(target, relation.targetColumn);
		return { accessor: target.accessor, where: { [targetTs]: value } };
	}
	const childFk = inverseFkColumn(meta, relation);
	if (!childFk) return null;
	const parentTs =
		tsForSql(source, relation.targetColumn) !== relation.targetColumn
			? tsForSql(source, relation.targetColumn)
			: (source.uniqueKeys[0]?.[0] ?? null);
	if (!parentTs) return null;
	const value = row[parentTs];
	if (value === undefined || value === null) return null;
	return { accessor: target.accessor, where: { [childFk]: value } };
}
