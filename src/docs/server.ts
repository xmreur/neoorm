import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { loadDocsPages, hydratePageTitles, type DocsPage } from "./pages.js";
import { renderDocsIndex, renderDocsPage } from "./render.js";
import { resolveDocsDir } from "./resolve-docs-dir.js";
import {
	buildSearchIndex,
	type DocsSearchRecord,
} from "./search.js";

export type DocsServerOptions = {
	port?: number;
	host?: string;
	open?: boolean;
	version: string;
};

function sendHtml(res: ServerResponse, status: number, html: string): void {
	res.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-cache",
	});
	res.end(html);
}

function sendText(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(body);
}

function parseSlug(pathname: string): string | null {
	const match = pathname.match(/^\/docs\/([^/]+)\/?$/);
	if (!match) {
		return null;
	}
	const slug = match[1];
	if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
		return null;
	}
	return slug;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-cache",
	});
	res.end(JSON.stringify(body));
}

export function createRequestHandler(
	pages: DocsPage[],
	version: string,
	searchIndex: DocsSearchRecord[],
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	const bySlug = new Map(pages.map((page) => [page.slug, page]));

	return async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const { pathname } = url;

		try {
			if (pathname === "/search-index.json") {
				sendJson(res, 200, searchIndex);
				return;
			}

			if (pathname === "/" || pathname === "/index.html") {
				sendHtml(res, 200, renderDocsIndex(pages, version));
				return;
			}

			const slug = parseSlug(pathname);
			if (!slug) {
				sendText(res, 404, "Not found");
				return;
			}

			const page = bySlug.get(slug);
			if (!page) {
				sendText(res, 404, `Unknown docs page "${slug}"`);
				return;
			}

			sendHtml(res, 200, await renderDocsPage(page, pages, version));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendText(res, 500, message);
		}
	};
}

function openBrowser(url: string): void {
	const platform = process.platform;
	const command =
		platform === "darwin"
			? "open"
			: platform === "win32"
				? "cmd"
				: "xdg-open";
	const args =
		platform === "win32" ? ["/c", "start", "", url] : [url];
	spawn(command, args, { detached: true, stdio: "ignore" }).unref();
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
		void handler(req, res);
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
