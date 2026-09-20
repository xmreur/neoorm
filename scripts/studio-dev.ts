import { type ChildProcess, spawn } from "node:child_process";

/** Run the Studio API (port 7584) and the Vite UI (port 7585, proxies /api). */
const children: ChildProcess[] = [];

function run(command: string, args: string[]): void {
	const child = spawn(command, args, {
		stdio: "inherit",
		env: process.env,
	});
	children.push(child);
	child.on("exit", (code, signal) => {
		if (signal) return;
		shutdown();
		process.exit(code ?? 0);
	});
}

function shutdown(): void {
	for (const child of children) {
		if (!child.killed) child.kill("SIGTERM");
	}
}

process.on("SIGINT", () => {
	shutdown();
	process.exit(0);
});
process.on("SIGTERM", () => {
	shutdown();
	process.exit(0);
});

run("bun", ["src/bin/neoorm.ts", "studio", "-p", "7584"]);
run("bunx", ["vite", "--config", "studio-web/vite.config.ts"]);
