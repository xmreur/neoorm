import {
	LOCKUP_DARK_SVG,
	LOCKUP_LIGHT_SVG,
	SYMBOL_DARK_SVG,
	SYMBOL_LIGHT_SVG,
} from "../../../src/docs/brand";

function svgUrl(markup: string): string {
	return `data:image/svg+xml,${encodeURIComponent(markup)}`;
}

export function BrandSymbol(): React.JSX.Element {
	return (
		<span className="brand-symbol-wrap" aria-hidden="true">
			<img
				className="brand-symbol brand-symbol-light"
				alt=""
				src={svgUrl(SYMBOL_LIGHT_SVG)}
			/>
			<img
				className="brand-symbol brand-symbol-dark"
				alt=""
				src={svgUrl(SYMBOL_DARK_SVG)}
			/>
		</span>
	);
}

export function BrandMark(): React.JSX.Element {
	return (
		<span
			className="inline-flex items-center gap-[9px] text-foreground"
			role="img"
			aria-label="NeoORM Studio"
		>
			<span className="brand-logo hidden md:inline-flex">
				<img
					className="brand-lockup brand-lockup-light"
					alt=""
					src={svgUrl(LOCKUP_LIGHT_SVG)}
				/>
				<img
					className="brand-lockup brand-lockup-dark"
					alt=""
					src={svgUrl(LOCKUP_DARK_SVG)}
				/>
			</span>
			<span className="inline-flex md:hidden">
				<BrandSymbol />
			</span>
			<span className="hidden rounded-full border border-border px-1.5 py-0.5 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase md:inline-flex">
				Studio
			</span>
		</span>
	);
}
