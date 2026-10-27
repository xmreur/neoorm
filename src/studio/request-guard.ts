import { isIP } from "node:net";

export type StudioBind = {
	host: string;
	port: number;
};

const JSON_MEDIA_TYPE = "application/json";

export function normalizeHostname(hostname: string): string {
	let value = hostname.trim().toLowerCase();
	if (value.startsWith("[") && value.endsWith("]")) {
		value = value.slice(1, -1);
	}
	while (value.endsWith(".")) {
		value = value.slice(0, -1);
	}
	return value;
}

export function isLoopbackHostname(hostname: string): boolean {
	const host = normalizeHostname(hostname);
	return (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host === "::ffff:127.0.0.1"
	);
}

export function parseHostHeader(
	value: string | undefined,
): { hostname: string; port: string | undefined } | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.includes("/")) return null;
	if (trimmed.startsWith("[")) {
		const end = trimmed.indexOf("]");
		if (end === -1) return null;
		const hostname = trimmed.slice(1, end);
		if (hostname === "") return null;
		const rest = trimmed.slice(end + 1);
		if (rest === "") return { hostname, port: undefined };
		if (!rest.startsWith(":")) return null;
		const port = rest.slice(1);
		if (port === "" || !/^\d+$/.test(port)) return null;
		return { hostname, port };
	}
	const colon = trimmed.lastIndexOf(":");
	if (colon === -1) {
		return { hostname: trimmed, port: undefined };
	}
	const maybePort = trimmed.slice(colon + 1);
	if (/^\d+$/.test(maybePort)) {
		const hostname = trimmed.slice(0, colon);
		if (hostname === "" || hostname.includes(":")) return null;
		return { hostname, port: maybePort };
	}
	return { hostname: trimmed, port: undefined };
}

export function isAllowedStudioHostname(
	hostname: string,
	bindHost: string,
): boolean {
	const host = normalizeHostname(hostname);
	if (host === "") return false;
	if (isLoopbackHostname(host)) return true;
	const bind = normalizeHostname(bindHost);
	if (host === bind) return true;
	if (bind === "0.0.0.0" || bind === "::") {
		return isIP(host) !== 0;
	}
	return false;
}

export function isAllowedStudioHostHeader(
	hostHeader: string | undefined,
	bind: StudioBind,
): boolean {
	const parsed = parseHostHeader(hostHeader);
	if (!parsed) return false;
	const port =
		parsed.port === undefined ? 80 : Number.parseInt(parsed.port, 10);
	if (!Number.isFinite(port) || port !== bind.port) return false;
	return isAllowedStudioHostname(parsed.hostname, bind.host);
}

export function isAllowedStudioOrigin(
	originHeader: string | undefined,
	bind: StudioBind,
): boolean {
	if (originHeader === undefined || originHeader === "") return true;
	if (originHeader === "null") return false;
	let url: URL;
	try {
		url = new URL(originHeader);
	} catch {
		return false;
	}
	if (originHeader !== url.origin) return false;
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	const port =
		url.port === ""
			? url.protocol === "https:"
				? 443
				: 80
			: Number.parseInt(url.port, 10);
	if (!Number.isFinite(port) || port !== bind.port) return false;
	return isAllowedStudioHostname(url.hostname, bind.host);
}

export function isJsonContentType(value: string | undefined): boolean {
	if (value === undefined) return false;
	const mediaType = value.split(";")[0]?.trim().toLowerCase();
	return mediaType === JSON_MEDIA_TYPE;
}

export function singleHeader(
	value: string | string[] | undefined,
): string | undefined {
	return typeof value === "string" ? value : undefined;
}
