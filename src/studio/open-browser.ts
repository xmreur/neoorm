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
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(command, args, { detached: true, stdio: "ignore" });
	} catch (err) {
		reportOpenError(command, err);
		return;
	}
	child.once("error", (err) => {
		reportOpenError(command, err);
	});
	child.unref();
}

function reportOpenError(command: string, err: unknown): void {
	const code =
		typeof err === "object" && err !== null && "code" in err
			? err.code
			: undefined;
	const detail =
		code === "ENOENT"
			? `${command} was not found`
			: err instanceof Error
				? err.message
				: String(err);
	console.error(`Could not open the browser: ${detail}`);
}
