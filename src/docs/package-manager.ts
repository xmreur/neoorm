import { escapeAttribute, escapeHtml } from "./html.js";

export const PACKAGE_MANAGERS = ["npm", "yarn", "pnpm", "bun"] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export type PackageManagerVariants = Record<PackageManager, string>;

type ParsedCommand =
	| { kind: "add"; packages: string[] }
	| { kind: "exec"; args: string[] }
	| { kind: "run"; script: string[] }
	| { kind: "lockfile" };

function joinCommand(parts: string[]): string {
	return parts.filter((part) => part !== "").join(" ");
}

function renderVariants(parsed: ParsedCommand): PackageManagerVariants {
	switch (parsed.kind) {
		case "add":
			return {
				npm: joinCommand(["npm", "install", ...parsed.packages]),
				yarn: joinCommand(["yarn", "add", ...parsed.packages]),
				pnpm: joinCommand(["pnpm", "add", ...parsed.packages]),
				bun: joinCommand(["bun", "add", ...parsed.packages]),
			};
		case "exec":
			return {
				npm: joinCommand(["npx", ...parsed.args]),
				yarn: joinCommand(["yarn", "dlx", ...parsed.args]),
				pnpm: joinCommand(["pnpm", "dlx", ...parsed.args]),
				bun: joinCommand(["bunx", ...parsed.args]),
			};
		case "run":
			return {
				npm: joinCommand(["npm", "run", ...parsed.script]),
				yarn: joinCommand(["yarn", ...parsed.script]),
				pnpm: joinCommand(["pnpm", "run", ...parsed.script]),
				bun: joinCommand(["bun", "run", ...parsed.script]),
			};
		case "lockfile":
			return {
				npm: "npm install",
				yarn: "yarn",
				pnpm: "pnpm install",
				bun: "bun install",
			};
		default: {
			const unreachable: never = parsed;
			return unreachable;
		}
	}
}

function parseCommand(command: string): ParsedCommand | null {
	const tokens = command
		.trim()
		.replace(/^\$\s+/, "")
		.split(/\s+/);
	const bin = tokens[0];
	if (!bin) {
		return null;
	}
	const args = tokens.slice(1);

	if (bin === "bun" && args[0] === "add") {
		return { kind: "add", packages: args.slice(1) };
	}
	if (bin === "bun" && args[0] === "run") {
		return { kind: "run", script: args.slice(1) };
	}
	if (bin === "bun" && args[0] === "install") {
		return args.length === 1
			? { kind: "lockfile" }
			: { kind: "add", packages: args.slice(1) };
	}
	if (bin === "bunx") {
		return { kind: "exec", args };
	}
	if (
		bin === "npm" &&
		(args[0] === "install" || args[0] === "i" || args[0] === "add")
	) {
		const packages = args.slice(1);
		if (packages.length === 0 && args[0] !== "add") {
			return { kind: "lockfile" };
		}
		return { kind: "add", packages };
	}
	if (bin === "npx") {
		return { kind: "exec", args };
	}
	if (bin === "npm" && args[0] === "run") {
		return { kind: "run", script: args.slice(1) };
	}
	if (bin === "yarn" && args[0] === "add") {
		return { kind: "add", packages: args.slice(1) };
	}
	if (bin === "yarn" && args[0] === "dlx") {
		return { kind: "exec", args: args.slice(1) };
	}
	if (bin === "yarn" && args[0] === "run") {
		return { kind: "run", script: args.slice(1) };
	}
	if (bin === "yarn" && args.length === 0) {
		return { kind: "lockfile" };
	}
	if (bin === "pnpm" && args[0] === "add") {
		return { kind: "add", packages: args.slice(1) };
	}
	if (bin === "pnpm" && (args[0] === "dlx" || args[0] === "exec")) {
		return { kind: "exec", args: args.slice(1) };
	}
	if (bin === "pnpm" && args[0] === "run") {
		return { kind: "run", script: args.slice(1) };
	}
	if (bin === "pnpm" && args[0] === "install") {
		return args.length === 1
			? { kind: "lockfile" }
			: { kind: "add", packages: args.slice(1) };
	}
	return null;
}

/** Translate one command. Returns null when the line is not a package-manager command. */
export function translateCommand(
	command: string,
): PackageManagerVariants | null {
	const parsed = parseCommand(command);
	return parsed ? renderVariants(parsed) : null;
}

function translateLine(line: string): PackageManagerVariants | null {
	const match = /^(\s*)(.*)$/.exec(line);
	const indent = match?.[1] ?? "";
	const body = match?.[2] ?? "";
	if (body.trim() === "" || body.trimStart().startsWith("#")) {
		return null;
	}
	const variants = translateCommand(body);
	if (!variants) {
		return null;
	}
	return {
		npm: `${indent}${variants.npm}`,
		yarn: `${indent}${variants.yarn}`,
		pnpm: `${indent}${variants.pnpm}`,
		bun: `${indent}${variants.bun}`,
	};
}

/** Translate a shell snippet. Unrelated lines stay put. Null when nothing can switch. */
export function translateShellBlock(
	source: string,
): PackageManagerVariants | null {
	const lines = source.replace(/\n$/, "").split("\n");
	const translated = lines.map((line) => translateLine(line));
	if (!translated.some((line) => line !== null)) {
		return null;
	}
	const variants: PackageManagerVariants = {
		npm: "",
		yarn: "",
		pnpm: "",
		bun: "",
	};
	for (const manager of PACKAGE_MANAGERS) {
		variants[manager] = lines
			.map((line, index) => translated[index]?.[manager] ?? line)
			.join("\n");
	}
	return variants;
}

function variantAttributes(variants: PackageManagerVariants): string {
	return PACKAGE_MANAGERS.map(
		(manager) => `data-${manager}="${escapeAttribute(variants[manager])}"`,
	).join(" ");
}

function managerTabs(): string {
	return PACKAGE_MANAGERS.map((manager) => {
		const selected = manager === "bun";
		return `<button type="button" class="pm-tab" role="tab" data-pm-choice="${manager}" aria-selected="${
			selected ? "true" : "false"
		}" tabindex="${selected ? "0" : "-1"}">${manager}</button>`;
	}).join("");
}

export function renderPackageManagerBlock(
	source: string,
	extraClass = "",
): string | null {
	const variants = translateShellBlock(source);
	if (!variants) {
		return null;
	}
	const className =
		extraClass === ""
			? "code-block pm-block"
			: `code-block pm-block ${extraClass}`;
	return `<div class="${className}" data-pm-block data-lang="bash">
<div class="code-block-header">
<div class="pm-switch" role="tablist" aria-label="Package manager">${managerTabs()}</div>
<button type="button" class="code-copy" data-copy>Copy</button>
</div>
<pre class="shiki shiki-fallback"><code data-pm-code ${variantAttributes(
		variants,
	)}>${escapeHtml(variants.bun)}</code></pre>
</div>`;
}

/** Compact two-row install widget for the docs hero. */
export function renderInstallCard(source: string): string | null {
	const variants = translateShellBlock(source);
	if (!variants) {
		return null;
	}
	return `<div class="install-card" data-pm-block>
<div class="install-card-head">
<div class="pm-switch" role="tablist" aria-label="Package manager">${managerTabs()}</div>
<button type="button" class="code-copy" data-copy>Copy</button>
</div>
<div class="install-card-body"><span class="install-prompt" aria-hidden="true">$</span><code data-pm-code ${variantAttributes(
		variants,
	)}>${escapeHtml(variants.bun)}</code></div>
</div>`;
}

export function renderPackageManagerInline(command: string): string | null {
	const variants = translateCommand(command);
	if (!variants) {
		return null;
	}
	return `<code class="pm-inline" data-pm-code ${variantAttributes(
		variants,
	)}>${escapeHtml(variants.bun)}</code>`;
}
