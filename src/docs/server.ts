import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { openBrowser } from "../studio/open-browser.js";
import { type DocsPage, hydratePageTitles, loadDocsPages } from "./pages.js";
import {
	docsAssets,
	renderDocsIndex,
	renderDocsPage,
	renderNotFound,
} from "./render.js";
import { resolveDocsDir } from "./resolve-docs-dir.js";
import {
	buildSearchIndex,
	type DocsSearchRecord,
	searchDocs,
} from "./search.js";

export type DocsServerOptions = {
	port?: number;
	host?: string;
	open?: boolean;
	version: string;
};

const ASSETS = docsAssets();

const SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
};

function sendHtml(res: ServerResponse, status: number, html: string): void {
	res.writeHead(status, {
		...SECURITY_HEADERS,
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-cache",
	});
	res.end(html);
}

function sendText(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, {
		...SECURITY_HEADERS,
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-cache",
	});
	res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		...SECURITY_HEADERS,
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-cache",
	});
	res.end(JSON.stringify(body));
}

function sendAsset(
	res: ServerResponse,
	status: number,
	contentType: string,
	body: string,
): void {
	res.writeHead(status, {
		...SECURITY_HEADERS,
		"Content-Type": contentType,
		"Cache-Control": "no-cache",
	});
	res.end(body);
}

function parseSlug(pathname: string): string | null {
	const match = pathname.match(/^\/docs\/([^/]+)\/?$/);
	if (!match) {
		return null;
	}
	let slug: string;
	try {
		slug = decodeURIComponent(match[1] ?? "");
	} catch {
		return null;
	}
	if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
		return null;
	}
	return slug;
}

export function createRequestHandler(
	pages: DocsPage[],
	version: string,
	searchIndex: DocsSearchRecord[],
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	const bySlug = new Map(pages.map((page) => [page.slug, page]));
	const pageCache = new Map<string, string>();
	let indexCache: string | undefined;

	return async (req, res) => {
		try {
			let url: URL;
			try {
				url = new URL(req.url ?? "/", "http://localhost");
			} catch {
				sendText(res, 400, "Invalid request URL");
				return;
			}
			const { pathname } = url;

			if (pathname === "/assets/docs.css") {
				sendAsset(res, 200, "text/css; charset=utf-8", ASSETS.css);
				return;
			}

			if (pathname === "/assets/docs.js") {
				sendAsset(
					res,
					200,
					"text/javascript; charset=utf-8",
					ASSETS.js,
				);
				return;
			}

			if (pathname === "/favicon.svg") {
				sendAsset(
					res,
					200,
					"image/svg+xml; charset=utf-8",
					ASSETS.favicon,
				);
				return;
			}

			if (pathname === "/search-index.json") {
				sendJson(res, 200, searchIndex);
				return;
			}

			if (pathname === "/search") {
				const query = url.searchParams.get("q") ?? "";
				sendJson(res, 200, {
					query,
					hits: searchDocs(query, searchIndex),
				});
				return;
			}

			if (pathname === "/" || pathname === "/index.html") {
				if (!indexCache) {
					indexCache = await renderDocsIndex(pages, version);
				}
				sendHtml(res, 200, indexCache);
				return;
			}

			const slug = parseSlug(pathname);
			if (!slug) {
				sendHtml(res, 404, renderNotFound(pages, version, pathname));
				return;
			}

			const page = bySlug.get(slug);
			if (!page) {
				sendHtml(res, 404, renderNotFound(pages, version, pathname));
				return;
			}

			let html = pageCache.get(slug);
			if (!html) {
				html = await renderDocsPage(page, pages, version);
				pageCache.set(slug, html);
			}
			sendHtml(res, 200, html);
		} catch (err) {
			console.error(err);
			if (res.headersSent) {
				res.destroy();
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			sendText(res, 500, message);
		}
	};
}

export async function startDocsServer(
	options: DocsServerOptions,
): Promise<{ url: string; close: () => Promise<void> }> {
	const docsDir = await resolveDocsDir();
	const pages = await loadDocsPages(docsDir);
	if (pages.length === 0) {
		throw new Error(`No markdown files found in ${docsDir}`);
	}
	await hydratePageTitles(pages);
	const searchIndex = await buildSearchIndex(pages);

	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 7583;
	const handler = createRequestHandler(pages, options.version, searchIndex);

	const server = createServer((req, res) => {
		void handler(req, res).catch((err: unknown) => {
			console.error(err);
			if (res.headersSent) {
				res.destroy();
				return;
			}
			sendText(res, 500, "Internal server error");
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});

	const url = `http://${host}:${port}`;
	if (options.open) {
		openBrowser(url);
	}

	return {
		url,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			}),
	};
}
