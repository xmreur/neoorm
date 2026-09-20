import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSchemaToManifest, readSnapshot } from "../codegen/generate.js";
import type { NeoOrmConfig } from "../config.js";
import { loadConfig } from "../config.js";
import type { DatabaseProvider } from "../datasource-provider.js";
import { dialectForProvider } from "../dialect/resolve.js";
import type { Dialect, Manifest } from "../dialect/types.js";
import {
	computeMigrationStatus,
	listMigrationsOnDisk,
} from "../migrate/runner.js";
import type { TableRepository } from "../runtime/client.js";
import { createNeoOrmClient } from "../runtime/client.js";
import type { SqliteDatabaseLike } from "../runtime/driver.js";
import {
	decodeStudioData,
	decodeStudioValue,
	decodeStudioWhere,
	encodeStudioRows,
} from "./codec.js";
import { parseCsv, toCsv, toMarkdown, toSqlInserts } from "./csv.js";
import { toStudioError } from "./errors.js";
import { toStudioGraph } from "./graph.js";
import { type StudioMeta, toStudioMeta } from "./meta.js";
import { openBrowser } from "./open-browser.js";

export type StudioServerOptions = {
	port?: number;
	host?: string;
	open?: boolean;
	/** Project root containing `neoorm.config.ts`. @default process.cwd() */
	cwd?: string;
	readOnly?: boolean;
	verbose?: boolean;
	/** Required when binding a non-loopback host (generated if omitted). */
	token?: string;
	version: string;
	/** Override the built UI directory (tests, dev). */
	uiDir?: string;
	/** Programmatic overrides (tests): skip config load. */
	manifest?: Manifest;
	connectionString?: string;
	provider?: DatabaseProvider;
	pgSchema?: string;
	migrationsDir?: string;
	/** Existing SQLite handle (tests, embedding). Takes precedence over connectionString for SQLite. */
	sqliteDb?: SqliteDatabaseLike;
};

export type StudioServer = {
	url: string;
	token?: string;
	close: () => Promise<void>;
};

type StudioClient = Record<string, TableRepository> & {
	execute(query: {
		text: string;
		params: unknown[];
	}): Promise<Record<string, unknown>[]>;
	$disconnect(): Promise<void>;
};

type StudioContext = {
	manifest: Manifest;
	meta: StudioMeta;
	client: StudioClient;
	dialect: Dialect;
	provider?: DatabaseProvider;
	pgSchema?: string;
	migrationsDir?: string;
	readOnly: boolean;
	verbose: boolean;
	token?: string;
	metaSource: "schema" | "snapshot";
};

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_TAKE = 50;
const MAX_TAKE = 500;
const MAX_EXPORT_TAKE = 5000;

const TEXT_SEARCH_KINDS = new Set([
	"text",
	"citext",
	"id",
	"uuid",
	"enum",
	"xml",
	"inet",
	"cidr",
	"money",
	"date",
	"time",
]);

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

function isLoopbackHost(host: string): boolean {
	return (
		host === "127.0.0.1" ||
		host === "localhost" ||
		host === "::1" ||
		host === "::ffff:127.0.0.1"
	);
}

export function resolveStudioUiDir(
	cwd: string,
	override?: string,
): string | null {
	const candidates = [
		override,
		process.env.STUDIO_UI_DIR,
		join(cwd, "dist", "studio-ui"),
		join(dirname(fileURLToPath(import.meta.url)), "..", "studio-ui"),
		join(cwd, "studio-web", "dist"),
	].filter((c): c is string => c !== undefined && c !== "");
	for (const dir of candidates) {
		try {
			if (existsSync(join(dir, "index.html"))) return dir;
		} catch {}
	}
	return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-cache",
	});
	res.end(JSON.stringify(body));
}

function sendText(
	res: ServerResponse,
	status: number,
	body: string,
	contentType = "text/plain; charset=utf-8",
): void {
	res.writeHead(status, { "Content-Type": contentType });
	res.end(body);
}

function sendFile(
	res: ServerResponse,
	filePath: string,
	contentType: string,
	body: string | Buffer,
): void {
	res.writeHead(200, {
		"Content-Type": contentType,
		"Cache-Control": "no-cache",
	});
	res.end(body);
	void filePath;
}

async function readBody(
	req: IncomingMessage,
	limit = MAX_BODY_BYTES,
): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf =
			typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
		size += buf.length;
		if (size > limit)
			throw new Error(`Request body exceeds ${limit} bytes`);
		chunks.push(buf);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

function parseJsonBody(text: string): unknown {
	if (text.trim() === "") return {};
	return JSON.parse(text) as unknown;
}

function getQueryParams(url: URL): URLSearchParams {
	return url.searchParams;
}

function parseTake(raw: string | null, max: number): number {
	if (raw === null) return DEFAULT_TAKE;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1)
		throw new Error("`take` must be a positive integer");
	return Math.min(n, max);
}

function parseSkip(raw: string | null): number {
	if (raw === null) return 0;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0)
		throw new Error("`skip` must be a non-negative integer");
	return n;
}

function parseJsonParam(raw: string | null, name: string): unknown {
	if (raw === null || raw === "") return undefined;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		throw new Error(`\`${name}\` must be JSON`);
	}
}

function tableOr404(ctx: StudioContext, accessor: string) {
	const table = ctx.manifest.tables[accessor];
	if (!table) {
		throw Object.assign(new Error(`Unknown table "${accessor}"`), {
			statusCode: 404,
			code: "unknown_table",
		});
	}
	return table;
}

function repoFor(ctx: StudioContext, accessor: string): TableRepository {
	tableOr404(ctx, accessor);
	const repo = ctx.client[accessor] as TableRepository | undefined;
	if (!repo || typeof repo.findMany !== "function") {
		throw Object.assign(new Error(`Unknown table "${accessor}"`), {
			statusCode: 404,
			code: "unknown_table",
		});
	}
	return repo;
}

function requireWritable(ctx: StudioContext): void {
	if (ctx.readOnly) {
		throw Object.assign(new Error("Studio is running with --read-only"), {
			statusCode: 403,
			code: "read_only",
		});
	}
}

/** Build a table-wide search predicate: OR of `contains` over text-like columns. */
function buildSearchWhere(
	ctx: StudioContext,
	accessor: string,
	q: string,
): Record<string, unknown> | undefined {
	const table = tableOr404(ctx, accessor);
	const needle = q.trim();
	if (needle === "") return undefined;
	const ors: Record<string, unknown>[] = [];
	for (const column of table.columns) {
		if (TEXT_SEARCH_KINDS.has(column.kind)) {
			ors.push({
				[column.tsName]: { contains: needle, mode: "insensitive" },
			});
		}
	}
	if (ors.length === 0) return undefined;
	return { OR: ors };
}

function mergeWhere(
	base: Record<string, unknown> | undefined,
	extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!base) return extra;
	if (!extra) return base;
	return { AND: [base, extra] };
}

const READ_SQL =
	/^\s*(SELECT|WITH|VALUES|TABLE|EXPLAIN|PRAGMA|SHOW|DESCRIBE|DESC)\b/i;

function isReadSql(text: string): boolean {
	return READ_SQL.test(text);
}

function errorStatus(err: unknown): number {
	const statusCode = (err as { statusCode?: unknown }).statusCode;
	if (typeof statusCode === "number") return statusCode;
	return toStudioError(err).status;
}

function errorBody(err: unknown): unknown {
	const code = (err as { code?: unknown }).code;
	if (typeof code === "string") {
		return {
			error: {
				code,
				message: err instanceof Error ? err.message : String(err),
			},
		};
	}
	return toStudioError(err).body;
}

async function handleApi(
	ctx: StudioContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<void> {
	const method = (req.method ?? "GET").toUpperCase();
	const segments = url.pathname.split("/").filter((s) => s.length > 0);

	if (ctx.token !== undefined) {
		const header = req.headers["x-studio-token"];
		const auth = req.headers.authorization;
		const queryToken = url.searchParams.get("token");
		const provided =
			(typeof header === "string" && header) ||
			(typeof auth === "string" && auth.startsWith("Bearer ")
				? auth.slice(7)
				: "") ||
			(queryToken ?? "");
		if (provided !== ctx.token) {
			sendJson(res, 401, {
				error: {
					code: "unauthorized",
					message: "Invalid or missing Studio token",
				},
			});
			return;
		}
	}

	try {
		// GET /api/meta
		if (
			method === "GET" &&
			segments.length === 2 &&
			segments[0] === "api" &&
			segments[1] === "meta"
		) {
			sendJson(res, 200, {
				...ctx.meta,
				readOnly: ctx.readOnly,
				dialect: ctx.dialect.name,
			});
			return;
		}

		// GET /api/graph
		if (
			method === "GET" &&
			segments.length === 2 &&
			segments[0] === "api" &&
			segments[1] === "graph"
		) {
			sendJson(res, 200, toStudioGraph(ctx.manifest));
			return;
		}

		// GET /api/migrate/status
		if (
			method === "GET" &&
			segments.length === 3 &&
			segments[0] === "api" &&
			segments[1] === "migrate" &&
			segments[2] === "status"
		) {
			sendJson(res, 200, await readMigrateStatus(ctx));
			return;
		}

		// /api/tables/:accessor/rows
		if (
			segments.length === 4 &&
			segments[0] === "api" &&
			segments[1] === "tables" &&
			segments[3] === "rows"
		) {
			const accessor = segments[2] ?? "";
			if (method === "GET") {
				await handleListRows(ctx, res, url, accessor);
				return;
			}
			if (method === "POST") {
				requireWritable(ctx);
				await handleCreateRows(ctx, req, res, accessor);
				return;
			}
			if (method === "PATCH") {
				requireWritable(ctx);
				await handleUpdateRows(ctx, req, res, accessor);
				return;
			}
			if (method === "DELETE") {
				requireWritable(ctx);
				await handleDeleteRows(ctx, req, res, url, accessor);
				return;
			}
			sendJson(res, 405, {
				error: {
					code: "method_not_allowed",
					message: `Method ${method} not allowed`,
				},
			});
			return;
		}

		// POST /api/query
		if (
			method === "POST" &&
			segments.length === 2 &&
			segments[0] === "api" &&
			segments[1] === "query"
		) {
			await handleQueryPlayground(ctx, req, res);
			return;
		}

		// POST /api/sql
		if (
			method === "POST" &&
			segments.length === 2 &&
			segments[0] === "api" &&
			segments[1] === "sql"
		) {
			await handleSql(ctx, req, res);
			return;
		}

		// POST /api/import
		if (
			method === "POST" &&
			segments.length === 2 &&
			segments[0] === "api" &&
			segments[1] === "import"
		) {
			requireWritable(ctx);
			await handleImport(ctx, req, res);
			return;
		}

		// GET /api/export
		if (
			method === "GET" &&
			segments.length === 2 &&
			segments[0] === "api" &&
			segments[1] === "export"
		) {
			await handleExport(ctx, res, url);
			return;
		}

		sendJson(res, 404, {
			error: {
				code: "not_found",
				message: `Unknown API route ${url.pathname}`,
			},
		});
	} catch (err) {
		sendJson(res, errorStatus(err), errorBody(err));
	}
}

async function handleListRows(
	ctx: StudioContext,
	res: ServerResponse,
	url: URL,
	accessor: string,
): Promise<void> {
	const repo = repoFor(ctx, accessor);
	const params = getQueryParams(url);
	const take = parseTake(params.get("take"), MAX_TAKE);
	const skip = parseSkip(params.get("skip"));
	const where = mergeWhere(
		decodeStudioWhere(parseJsonParam(params.get("where"), "where")),
		buildSearchWhere(ctx, accessor, params.get("q") ?? ""),
	);
	const orderBy = parseJsonParam(params.get("orderBy"), "orderBy") as
		| Record<string, string>
		| undefined;
	const withParam = parseJsonParam(params.get("with"), "with") as
		| Record<string, unknown>
		| undefined;
	const args = {
		...(where ? { where } : {}),
		...(orderBy ? { orderBy: orderBy as never } : {}),
		take,
		skip,
		...(withParam ? { with: decodeStudioValue(withParam) as never } : {}),
		includeHidden: true,
	};
	const [rows, total] = await Promise.all([
		repo.findMany(args),
		repo.count(where ? { where } : undefined),
	]);
	sendJson(res, 200, {
		rows: encodeStudioRows(rows),
		total: typeof total === "number" ? total : 0,
		take,
		skip,
	});
}

async function handleCreateRows(
	ctx: StudioContext,
	req: IncomingMessage,
	res: ServerResponse,
	accessor: string,
): Promise<void> {
	const repo = repoFor(ctx, accessor);
	const table = tableOr404(ctx, accessor);
	const body = parseJsonBody(await readBody(req)) as Record<string, unknown>;
	if (Array.isArray(body.rows)) {
		if (body.rows.length === 0) {
			sendJson(res, 400, {
				error: {
					code: "invalid_args",
					message: "`rows` must not be empty",
				},
			});
			return;
		}
		if (body.rows.length > MAX_EXPORT_TAKE) {
			sendJson(res, 400, {
				error: {
					code: "invalid_args",
					message: "`rows` exceeds the 5000-row import limit",
				},
			});
			return;
		}
		const data = (body.rows as Record<string, unknown>[]).map((row) =>
			decodeStudioData(table, row),
		);
		const count = await repo.createMany({
			data,
			...(body.skipDuplicates === true ? { skipDuplicates: true } : {}),
		});
		sendJson(res, 201, { count });
		return;
	}
	if (typeof body.data !== "object" || body.data === null) {
		sendJson(res, 400, {
			error: {
				code: "invalid_args",
				message: "Expected `{data}` or `{rows}`",
			},
		});
		return;
	}
	const created = await repo.create({
		data: decodeStudioData(table, body.data as Record<string, unknown>),
		returnCreated: true,
	});
	sendJson(res, 201, { row: encodeStudioRows([created])[0] });
}

async function handleUpdateRows(
	ctx: StudioContext,
	req: IncomingMessage,
	res: ServerResponse,
	accessor: string,
): Promise<void> {
	const repo = repoFor(ctx, accessor);
	const table = tableOr404(ctx, accessor);
	const body = parseJsonBody(await readBody(req)) as Record<string, unknown>;
	const data = body.data;
	if (typeof data !== "object" || data === null) {
		sendJson(res, 400, {
			error: {
				code: "invalid_args",
				message: "Expected `{where, data}`",
			},
		});
		return;
	}
	if (body.many === true) {
		const where = decodeStudioWhere(body.where);
		const count = await repo.updateMany({
			...(where ? { where } : {}),
			data: decodeStudioData(table, data as Record<string, unknown>),
		});
		sendJson(res, 200, { count });
		return;
	}
	const where = decodeStudioWhere(body.where);
	if (!where) {
		sendJson(res, 400, {
			error: {
				code: "where_required",
				message: "Single-row update requires a unique `where`",
			},
		});
		return;
	}
	const updated = await repo.update({
		where,
		data: decodeStudioData(table, data as Record<string, unknown>),
		returnUpdated: true,
	});
	if (updated === null) {
		sendJson(res, 404, {
			error: { code: "not_found", message: "No row matched `where`" },
		});
		return;
	}
	sendJson(res, 200, { row: encodeStudioRows([updated])[0] });
}

async function handleDeleteRows(
	ctx: StudioContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	accessor: string,
): Promise<void> {
	const repo = repoFor(ctx, accessor);
	let body: Record<string, unknown> = {};
	try {
		body = parseJsonBody(await readBody(req)) as Record<string, unknown>;
	} catch {
		body = {};
	}
	const whereParam = url.searchParams.get("where");
	const where = decodeStudioWhere(
		body.where !== undefined
			? body.where
			: parseJsonParam(whereParam, "where"),
	);
	if (body.many === true || url.searchParams.get("many") === "true") {
		const count = await repo.deleteMany(where ? { where } : undefined);
		sendJson(res, 200, { count });
		return;
	}
	if (!where) {
		sendJson(res, 400, {
			error: {
				code: "where_required",
				message: "Single-row delete requires a unique `where`",
			},
		});
		return;
	}
	const deleted = await repo.delete({ where });
	if (deleted === null) {
		sendJson(res, 404, {
			error: { code: "not_found", message: "No row matched `where`" },
		});
		return;
	}
	sendJson(res, 200, { row: encodeStudioRows([deleted])[0] });
}

const QUERY_METHODS = new Set([
	"findMany",
	"findFirst",
	"findUnique",
	"findById",
	"count",
	"exists",
	"aggregate",
	"groupBy",
	"paginate",
]);

async function handleQueryPlayground(
	ctx: StudioContext,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const body = parseJsonBody(await readBody(req)) as Record<string, unknown>;
	const accessor = body.accessor;
	const method = body.method;
	if (
		typeof accessor !== "string" ||
		typeof method !== "string" ||
		!QUERY_METHODS.has(method)
	) {
		sendJson(res, 400, {
			error: {
				code: "invalid_args",
				message:
					"Expected `{accessor, method, args}` with a valid method",
			},
		});
		return;
	}
	const repo = repoFor(ctx, accessor);
	const rawArgs = (body.args ?? {}) as Record<string, unknown>;
	const args = decodeStudioValue(rawArgs) as Record<string, unknown>;
	const withHidden = { includeHidden: true };

	switch (method) {
		case "findMany": {
			const rows = await repo.findMany({
				...args,
				...withHidden,
			} as never);
			sendJson(res, 200, { rows: encodeStudioRows(rows) });
			return;
		}
		case "findFirst": {
			const row = await repo.findFirst({
				...args,
				...withHidden,
			} as never);
			sendJson(res, 200, {
				row: row ? encodeStudioRows([row])[0] : null,
			});
			return;
		}
		case "findUnique": {
			if (typeof args.where !== "object" || args.where === null) {
				sendJson(res, 400, {
					error: {
						code: "where_required",
						message: "`findUnique` requires a unique `where`",
					},
				});
				return;
			}
			const row = await repo.findUnique({
				where: args.where as Record<string, unknown>,
				...(args.select !== undefined
					? { select: args.select as never }
					: {}),
				...(args.omit !== undefined
					? { omit: args.omit as never }
					: {}),
				...(args.with !== undefined
					? { with: args.with as never }
					: {}),
				...withHidden,
			});
			sendJson(res, 200, {
				row: row ? encodeStudioRows([row])[0] : null,
			});
			return;
		}
		case "findById": {
			const id = args.id as string | Record<string, unknown>;
			if (
				typeof id !== "string" &&
				(typeof id !== "object" || id === null)
			) {
				sendJson(res, 400, {
					error: {
						code: "invalid_args",
						message: "`findById` requires `args.id`",
					},
				});
				return;
			}
			const row = await repo.findById(id);
			sendJson(res, 200, {
				row: row ? encodeStudioRows([row])[0] : null,
			});
			return;
		}
		case "count": {
			const total = await repo.count(args as never);
			sendJson(res, 200, { result: total });
			return;
		}
		case "exists": {
			const found = await repo.exists(args as never);
			sendJson(res, 200, { result: found });
			return;
		}
		case "aggregate": {
			const result = await repo.aggregate(args as never);
			sendJson(res, 200, { result: encodeStudioRows([result])[0] });
			return;
		}
		case "groupBy": {
			if (args.by === undefined) {
				sendJson(res, 400, {
					error: {
						code: "invalid_args",
						message: "`groupBy` requires `by`",
					},
				});
				return;
			}
			const result = await repo.groupBy(args as never);
			sendJson(res, 200, { rows: encodeStudioRows(result) });
			return;
		}
		case "paginate": {
			if (
				typeof args.orderBy !== "object" ||
				args.orderBy === null ||
				typeof args.take !== "number"
			) {
				sendJson(res, 400, {
					error: {
						code: "invalid_args",
						message: "`paginate` requires `{orderBy, take}`",
					},
				});
				return;
			}
			const page = await repo.paginate({
				...args,
				...withHidden,
			} as never);
			sendJson(res, 200, {
				...page,
				items: encodeStudioRows(page.items),
			});
			return;
		}
		default: {
			const _never: never = method as never;
			sendJson(res, 400, {
				error: {
					code: "invalid_args",
					message: `Unsupported method ${_never}`,
				},
			});
			return;
		}
	}
}

async function handleSql(
	ctx: StudioContext,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const body = parseJsonBody(await readBody(req)) as Record<string, unknown>;
	if (typeof body.text !== "string" || body.text.trim() === "") {
		sendJson(res, 400, {
			error: {
				code: "invalid_args",
				message: "Expected `{text}` with SQL",
			},
		});
		return;
	}
	const paramsRaw = body.params;
	const params = Array.isArray(paramsRaw)
		? (decodeStudioValue(paramsRaw) as unknown[])
		: [];
	let text = body.text;
	if (body.explain === "analyze") text = `EXPLAIN ANALYZE ${text}`;
	else if (body.explain === true) text = `EXPLAIN ${text}`;
	if (ctx.readOnly && !isReadSql(text)) {
		sendJson(res, 403, {
			error: {
				code: "read_only",
				message: "Only read queries are allowed with --read-only",
			},
		});
		return;
	}
	const rows = await ctx.client.execute({ text, params });
	sendJson(res, 200, { rows: encodeStudioRows(rows), rowCount: rows.length });
}

type ImportRow = Record<string, unknown>;

function coerceImportValue(raw: string): unknown {
	if (raw === "") return null;
	const lowered = raw.toLowerCase();
	if (lowered === "true") return true;
	if (lowered === "false") return false;
	if (lowered === "null") return null;
	if (/^-?\d+$/.test(raw)) {
		const n = Number(raw);
		if (Number.isSafeInteger(n)) return n;
		return { __neoorm: "bigint", value: raw };
	}
	if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
	return raw;
}

async function handleImport(
	ctx: StudioContext,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const body = parseJsonBody(await readBody(req)) as Record<string, unknown>;
	const accessor = body.accessor;
	if (typeof accessor !== "string") {
		sendJson(res, 400, {
			error: {
				code: "invalid_args",
				message:
					'Expected `{accessor, rows}` or `{accessor, format: "csv", csv}`',
			},
		});
		return;
	}
	const repo = repoFor(ctx, accessor);
	const table = tableOr404(ctx, accessor);
	let rows: ImportRow[];
	if (typeof body.csv === "string") {
		const parsed = parseCsv(body.csv);
		rows = parsed.rows.map((row) => {
			const out: ImportRow = {};
			for (const [k, v] of Object.entries(row))
				out[k] = coerceImportValue(v);
			return out;
		});
	} else if (Array.isArray(body.rows)) {
		rows = body.rows as ImportRow[];
	} else {
		sendJson(res, 400, {
			error: {
				code: "invalid_args",
				message:
					'Expected `{accessor, rows}` or `{accessor, format: "csv", csv}`',
			},
		});
		return;
	}
	if (rows.length === 0) {
		sendJson(res, 400, {
			error: { code: "invalid_args", message: "No rows to import" },
		});
		return;
	}
	if (rows.length > MAX_EXPORT_TAKE) {
		sendJson(res, 400, {
			error: {
				code: "invalid_args",
				message: "Import exceeds the 5000-row limit",
			},
		});
		return;
	}
	const data = rows.map((row) => decodeStudioData(table, row));
	const count = await repo.createMany({
		data,
		...(body.skipDuplicates === true ? { skipDuplicates: true } : {}),
	});
	sendJson(res, 201, { count });
}

async function handleExport(
	ctx: StudioContext,
	res: ServerResponse,
	url: URL,
): Promise<void> {
	const params = getQueryParams(url);
	const accessor = params.get("accessor");
	if (!accessor) {
		sendJson(res, 400, {
			error: { code: "invalid_args", message: "Missing `?accessor=`" },
		});
		return;
	}
	const repo = repoFor(ctx, accessor);
	const format = params.get("format") ?? "json";
	if (
		format !== "json" &&
		format !== "csv" &&
		format !== "md" &&
		format !== "sql"
	) {
		sendJson(res, 400, {
			error: {
				code: "invalid_args",
				message: "Unsupported format (json, csv, md, sql)",
			},
		});
		return;
	}
	const take = parseTake(params.get("take"), MAX_EXPORT_TAKE);
	const skip = parseSkip(params.get("skip"));
	const where = mergeWhere(
		decodeStudioWhere(parseJsonParam(params.get("where"), "where")),
		buildSearchWhere(ctx, accessor, params.get("q") ?? ""),
	);
	const orderBy = parseJsonParam(params.get("orderBy"), "orderBy") as
		| Record<string, string>
		| undefined;
	const rows = encodeStudioRows(
		await repo.findMany({
			...(where ? { where } : {}),
			...(orderBy ? { orderBy: orderBy as never } : {}),
			take,
			skip,
			includeHidden: true,
		}),
	);
	const table = tableOr404(ctx, accessor);
	const tsColumns = table.columns.map((c) => c.tsName);
	if (format === "json") {
		sendJson(res, 200, { rows, take, skip });
		return;
	}
	if (format === "csv") {
		sendText(res, 200, toCsv(tsColumns, rows), "text/csv; charset=utf-8");
		return;
	}
	if (format === "md") {
		sendText(
			res,
			200,
			toMarkdown(tsColumns, rows),
			"text/markdown; charset=utf-8",
		);
		return;
	}
	const qualified =
		ctx.pgSchema && ctx.dialect.name === "postgresql"
			? `${ctx.dialect.quoteIdentifier(ctx.pgSchema)}.${ctx.dialect.quoteIdentifier(table.sqlName)}`
			: ctx.dialect.quoteIdentifier(table.sqlName);
	sendText(
		res,
		200,
		`${toSqlInserts(
			qualified,
			(name) => ctx.dialect.quoteIdentifier(name),
			table.columns.map((c) => c.sqlName),
			tsColumns,
			rows,
		)}\n`,
		"text/plain; charset=utf-8",
	);
}

async function readMigrateStatus(ctx: StudioContext): Promise<unknown> {
	if (!ctx.migrationsDir) {
		return {
			available: false as const,
			reason: "No migrations directory configured",
		};
	}
	const disk = await listMigrationsOnDisk(ctx.migrationsDir);
	let applied: {
		name: string;
		appliedAt: string;
		checksum: string | null;
	}[] = [];
	try {
		const rows = await ctx.client.execute({
			text: `SELECT ${ctx.dialect.quoteIdentifier("name")}, ${ctx.dialect.quoteIdentifier("checksum")}, ${ctx.dialect.quoteIdentifier("applied_at")} FROM ${ctx.dialect.quoteIdentifier("_neoorm_migrations")} ORDER BY ${ctx.dialect.quoteIdentifier("name")} ASC`,
			params: [],
		});
		applied = rows.map((row) => ({
			name: String(row.name),
			appliedAt:
				row.applied_at instanceof Date
					? row.applied_at.toISOString()
					: String(row.applied_at ?? ""),
			checksum:
				row.checksum === null || row.checksum === undefined
					? null
					: String(row.checksum),
		}));
	} catch {
		applied = [];
	}
	const status = computeMigrationStatus(
		disk,
		applied.map((a) => ({
			name: a.name,
			appliedAt: new Date(a.appliedAt),
			checksum: a.checksum,
		})),
	);
	return {
		available: true as const,
		migrationsDir: ctx.migrationsDir,
		applied,
		pending: status.pending,
		orphanApplied: status.orphanApplied,
	};
}

export function createStudioRequestHandler(
	ctx: StudioContext,
	uiDir: string | null,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	return async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const { pathname } = url;
		try {
			if (pathname === "/api" || pathname.startsWith("/api/")) {
				await handleApi(ctx, req, res, url);
				return;
			}
			if (!uiDir) {
				sendText(
					res,
					200,
					"NeoOrm Studio UI is not built. Run `bun run build` (or `bun run studio:dev`) and restart `neoorm studio`.",
				);
				return;
			}
			const relative =
				pathname === "/"
					? "index.html"
					: (pathname.slice(1).split("?")[0] ?? "index.html");
			const normalized = relative.includes("..")
				? "index.html"
				: relative;
			let filePath = join(uiDir, normalized);
			try {
				const fileStat = await stat(filePath);
				if (fileStat.isDirectory())
					filePath = join(uiDir, "index.html");
			} catch {
				filePath = join(uiDir, "index.html");
			}
			const contentType =
				MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
			const body = await readFile(filePath);
			sendFile(res, filePath, contentType, body);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendText(res, 500, message);
		}
	};
}

async function loadStudioManifest(
	cwd: string,
	config: NeoOrmConfig,
): Promise<{ manifest: Manifest; metaSource: "schema" | "snapshot" }> {
	const schemaPath = resolve(cwd, config.schema);
	const pgSchema =
		config.datasource.provider === "postgresql"
			? config.datasource.schema
			: undefined;
	try {
		const { manifest } = await compileSchemaToManifest(schemaPath, {
			...(config.datasource.provider
				? { provider: config.datasource.provider }
				: {}),
			...(config.datasource.enum
				? { enumMode: config.datasource.enum }
				: {}),
			...(pgSchema ? { schema: pgSchema } : {}),
		});
		return { manifest, metaSource: "schema" };
	} catch (schemaErr) {
		const outDir = resolve(cwd, config.out);
		const snapshot = await readSnapshot(outDir);
		if (snapshot) return { manifest: snapshot, metaSource: "snapshot" };
		const detail =
			schemaErr instanceof Error ? schemaErr.message : String(schemaErr);
		throw new Error(
			`Could not compile schema.ts and no snapshot.json was found. Run \`neoorm generate\` or fix schema.ts.\n${detail}`,
		);
	}
}

export function buildStudioClient(
	manifest: Manifest,
	options: {
		connectionString?: string;
		provider?: DatabaseProvider;
		pgSchema?: string;
		migrationsDir?: string;
		verbose?: boolean;
		sqliteDb?: SqliteDatabaseLike;
	},
): StudioClient {
	const client = createNeoOrmClient(manifest, {
		...(options.connectionString !== undefined
			? { connectionString: options.connectionString }
			: {}),
		...(options.provider !== undefined
			? { provider: options.provider }
			: {}),
		...(options.pgSchema !== undefined ? { schema: options.pgSchema } : {}),
		...(options.migrationsDir !== undefined
			? { migrationsDir: options.migrationsDir }
			: {}),
		...(options.sqliteDb !== undefined ? { db: options.sqliteDb } : {}),
		...(options.verbose
			? {
					beforeQuery: (event) => {
						console.log(`[studio] ${event.method} ${event.sql}`);
					},
					afterQuery: (event) => {
						if (event.error)
							console.log(
								`[studio] error after ${event.durationMs}ms: ${String(event.error)}`,
							);
						else
							console.log(
								`[studio] done in ${event.durationMs}ms`,
							);
					},
				}
			: {}),
	}) as unknown as StudioClient;
	return client;
}

export async function startStudioServer(
	options: StudioServerOptions,
): Promise<StudioServer> {
	const cwd = options.cwd ?? process.cwd();
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 7584;
	const readOnly = options.readOnly ?? false;
	const verbose = options.verbose ?? false;

	let token = options.token;
	if (!isLoopbackHost(host) && token === undefined) {
		token = randomUUID();
	}

	let manifest = options.manifest;
	let metaSource: "schema" | "snapshot" = "schema";
	let provider = options.provider;
	let pgSchema = options.pgSchema;
	let migrationsDir = options.migrationsDir;
	let connectionString = options.connectionString;

	if (!manifest) {
		const config = await loadConfig(cwd);
		const loaded = await loadStudioManifest(cwd, config);
		manifest = loaded.manifest;
		metaSource = loaded.metaSource;
		provider = config.datasource.provider;
		pgSchema =
			config.datasource.provider === "postgresql"
				? config.datasource.schema
				: undefined;
		connectionString = config.datasource.url;
		migrationsDir = resolve(cwd, config.out, "migrations");
		if (metaSource === "snapshot") {
			console.warn(
				"Warning: schema.ts did not compile; Studio is showing snapshot.json and may be stale",
			);
		}
	}

	const client = buildStudioClient(manifest, {
		...(connectionString !== undefined ? { connectionString } : {}),
		...(provider !== undefined ? { provider } : {}),
		...(pgSchema !== undefined ? { pgSchema } : {}),
		...(migrationsDir !== undefined ? { migrationsDir } : {}),
		...(verbose ? { verbose: true } : {}),
		...(options.sqliteDb !== undefined
			? { sqliteDb: options.sqliteDb }
			: {}),
	});
	const dialect = dialectForProvider(
		provider ?? manifest.provider ?? "postgresql",
	);
	const meta = toStudioMeta(manifest, {
		metaSource,
		...(pgSchema !== undefined ? { pgSchema } : {}),
	});

	const ctx: StudioContext = {
		manifest,
		meta,
		client,
		dialect,
		...(provider !== undefined ? { provider } : {}),
		...(pgSchema !== undefined ? { pgSchema } : {}),
		...(migrationsDir !== undefined ? { migrationsDir } : {}),
		readOnly,
		verbose,
		...(token !== undefined ? { token } : {}),
		metaSource,
	};

	const uiDir = resolveStudioUiDir(cwd, options.uiDir);
	const handler = createStudioRequestHandler(ctx, uiDir);
	const server = createServer((req, res) => {
		void handler(req, res);
	});

	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolvePromise());
	});

	const address = server.address();
	const actualPort =
		typeof address === "object" && address !== null ? address.port : port;
	const url = `http://${host}:${actualPort}`;
	const openUrl =
		token !== undefined
			? `${url}/?token=${encodeURIComponent(token)}`
			: url;
	if (options.open) openBrowser(openUrl);

	return {
		url,
		...(token !== undefined ? { token } : {}),
		close: async () => {
			await client.$disconnect().catch(() => undefined);
			await new Promise<void>((resolvePromise, reject) => {
				server.close((err) => {
					if (err) reject(err);
					else resolvePromise();
				});
			});
		},
	};
}
