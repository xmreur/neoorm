import {
	type ButtonHTMLAttributes,
	type InputHTMLAttributes,
	type ReactNode,
	type Ref,
	type SelectHTMLAttributes,
	type TextareaHTMLAttributes,
	useEffect,
	useRef,
} from "react";
import { cn } from "./lib";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
	size?: "sm" | "md" | "icon";
};

export function Button({
	variant = "default",
	size = "md",
	className,
	type,
	...rest
}: ButtonProps): React.JSX.Element {
	return (
		<button
			type={type ?? "button"}
			className={cn(
				"inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors",
				"disabled:pointer-events-none disabled:opacity-50",
				variant === "default" &&
					"bg-primary text-primary-foreground hover:opacity-90",
				variant === "secondary" &&
					"bg-secondary text-secondary-foreground hover:opacity-90",
				variant === "outline" &&
					"border border-border bg-transparent hover:bg-accent hover:text-accent-foreground",
				variant === "ghost" &&
					"hover:bg-accent hover:text-accent-foreground",
				variant === "destructive" &&
					"bg-destructive text-destructive-foreground hover:opacity-90",
				size === "sm" && "h-7 px-2.5 text-xs",
				size === "md" && "h-8 px-3 text-sm",
				size === "icon" && "size-8 text-sm",
				className,
			)}
			{...rest}
		/>
	);
}

export function Input({
	className,
	ref,
	...rest
}: InputHTMLAttributes<HTMLInputElement> & {
	ref?: Ref<HTMLInputElement>;
}): React.JSX.Element {
	return (
		<input
			ref={ref}
			className={cn(
				"h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm outline-none",
				"placeholder:text-muted-foreground focus:border-ring",
				className,
			)}
			{...rest}
		/>
	);
}

export function Textarea({
	className,
	ref,
	...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
	ref?: Ref<HTMLTextAreaElement>;
}): React.JSX.Element {
	return (
		<textarea
			ref={ref}
			className={cn(
				"mono w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none",
				"placeholder:text-muted-foreground focus:border-ring",
				className,
			)}
			{...rest}
		/>
	);
}

export function Select({
	className,
	children,
	ref,
	...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
	children: ReactNode;
	ref?: Ref<HTMLSelectElement>;
}): React.JSX.Element {
	return (
		<select
			ref={ref}
			className={cn(
				"h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:border-ring [&>option]:bg-popover",
				className,
			)}
			{...rest}
		>
			{children}
		</select>
	);
}

export function Badge({
	className,
	children,
	title,
}: {
	className?: string;
	children: ReactNode;
	title?: string;
}): React.JSX.Element {
	return (
		<span
			title={title}
			className={cn(
				"inline-flex items-center rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground",
				className,
			)}
		>
			{children}
		</span>
	);
}

export function Card({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}): React.JSX.Element {
	return (
		<div
			className={cn(
				"rounded-lg border border-border bg-card text-card-foreground",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function CardHeader({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}): React.JSX.Element {
	return (
		<div className={cn("flex flex-col gap-1 p-4 pb-2", className)}>
			{children}
		</div>
	);
}

export function CardTitle({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}): React.JSX.Element {
	return (
		<h3 className={cn("text-sm font-semibold", className)}>{children}</h3>
	);
}

export function CardDescription({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}): React.JSX.Element {
	return (
		<p className={cn("text-xs text-muted-foreground", className)}>
			{children}
		</p>
	);
}

export function CardContent({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}): React.JSX.Element {
	return <div className={cn("p-4 pt-2", className)}>{children}</div>;
}

export function Spinner({
	className,
}: {
	className?: string;
}): React.JSX.Element {
	return (
		<span
			className={cn(
				"inline-block size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent",
				className,
			)}
		/>
	);
}

export function Empty({
	title,
	hint,
	action,
}: {
	title: string;
	hint?: string;
	action?: ReactNode;
}): React.JSX.Element {
	return (
		<div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
			<p className="text-sm font-medium">{title}</p>
			{hint ? (
				<p className="max-w-md text-xs text-muted-foreground">{hint}</p>
			) : null}
			{action}
		</div>
	);
}

export function Field({
	label,
	children,
	hint,
}: {
	label: string;
	children: ReactNode;
	hint?: string;
}): React.JSX.Element {
	return (
		<div className="flex flex-col gap-1 text-xs">
			<span className="font-medium text-muted-foreground">{label}</span>
			{children}
			{hint ? (
				<span className="text-[11px] text-muted-foreground">
					{hint}
				</span>
			) : null}
		</div>
	);
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
	return (
		<kbd className="mono rounded border border-border bg-muted px-1 py-0.5 text-[10px]">
			{children}
		</kbd>
	);
}

export function Dialog({
	open,
	onClose,
	title,
	children,
	wide,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
	wide?: boolean;
}): React.JSX.Element | null {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		ref.current
			?.querySelector<HTMLElement>("input, textarea, select, button")
			?.focus();
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);
	if (!open) return null;
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button
				type="button"
				className="absolute inset-0 bg-black/60"
				aria-label="Close dialog"
				onClick={onClose}
			/>
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className={cn(
					"relative z-10 max-h-[90vh] w-full overflow-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl",
					wide ? "max-w-3xl" : "max-w-lg",
				)}
			>
				<div className="mb-3 flex items-center justify-between">
					<h2 className="text-sm font-semibold">{title}</h2>
					<Button
						variant="ghost"
						size="icon"
						onClick={onClose}
						aria-label="Close"
					>
						✕
					</Button>
				</div>
				{children}
			</div>
		</div>
	);
}

export function Tabs<T extends string>({
	tabs,
	active,
	onChange,
}: {
	tabs: { id: T; label: string }[];
	active: T;
	onChange: (id: T) => void;
}): React.JSX.Element {
	return (
		<div className="flex gap-1 rounded-md bg-muted p-1">
			{tabs.map((t) => (
				<button
					key={t.id}
					type="button"
					onClick={() => onChange(t.id)}
					className={cn(
						"rounded px-2.5 py-1 text-xs font-medium",
						t.id === active
							? "bg-card text-card-foreground shadow"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{t.label}
				</button>
			))}
		</div>
	);
}
