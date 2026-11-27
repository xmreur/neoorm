export function IconSearch(): React.JSX.Element {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			className="size-4 shrink-0"
			aria-hidden="true"
		>
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-3.5-3.5" />
		</svg>
	);
}

export function IconSun(): React.JSX.Element {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			className="size-[17px]"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
		</svg>
	);
}

export function IconMoon(): React.JSX.Element {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			className="size-[17px]"
			aria-hidden="true"
		>
			<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
		</svg>
	);
}

function chevronPath(direction: "left" | "right" | "down"): string {
	switch (direction) {
		case "left":
			return "m15 18-6-6 6-6";
		case "right":
			return "m9 18 6-6-6-6";
		case "down":
			return "m6 9 6 6 6-6";
		default: {
			const unreachable: never = direction;
			return unreachable;
		}
	}
}

export function IconChevron({
	direction,
}: {
	direction: "left" | "right" | "down";
}): React.JSX.Element {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className="size-4"
			aria-hidden="true"
		>
			<path d={chevronPath(direction)} />
		</svg>
	);
}

export function IconRefresh(): React.JSX.Element {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className="size-4"
			aria-hidden="true"
		>
			<path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
			<path d="M3 21v-5h5" />
			<path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
			<path d="M21 3v5h-5" />
		</svg>
	);
}

export function IconClose(): React.JSX.Element {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			className="size-4"
			aria-hidden="true"
		>
			<path d="M18 6 6 18M6 6l12 12" />
		</svg>
	);
}
