import { spawn } from "node:child_process";

/**
 * URL passed to the browser launcher. The launcher's arguments, and the
 * browser's history, keep this string, so a `token` query parameter is removed.
 */
export function browserOpenUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.searchParams.delete("token");
		return parsed.toString();
	} catch {
		return url;
	}
}

/** Open a URL in the user's default browser (best effort, detached). */
export function openBrowser(url: string): void {
	const safeUrl = browserOpenUrl(url);
	const platform = process.platform;
	const command =
		platform === "darwin"
			? "open"
			: platform === "win32"
				? "cmd"
				: "xdg-open";
	const args =
		platform === "win32" ? ["/c", "start", "", safeUrl] : [safeUrl];
	spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}
