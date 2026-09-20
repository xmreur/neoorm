import { spawn } from "node:child_process";

/** Open a URL in the user's default browser (best effort, detached). */
export function openBrowser(url: string): void {
	const platform = process.platform;
	const command =
		platform === "darwin"
			? "open"
			: platform === "win32"
				? "cmd"
				: "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", url] : [url];
	spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}
