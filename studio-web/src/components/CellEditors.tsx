import { defaultKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
	editText,
	enumValues,
	formatCell,
	fullCellText,
	isGeoKind,
	isJsonKind,
	isMarker,
	type StudioColumnMeta,
} from "../api";
import { cn } from "./lib";
import { Button, Select, Textarea } from "./ui";

/** Focus a cell editor on mount, like a spreadsheet (explicit focus, not the autofocus attribute). */
function useEditorFocus<T extends HTMLElement>(): RefObject<T | null> {
	const ref = useRef<T>(null);
	useEffect(() => {
		ref.current?.focus();
	}, []);
	return ref;
}

export function CellView({
	value,
	column,
	wrap,
}: {
	value: unknown;
	column: StudioColumnMeta;
	wrap: boolean;
}): React.JSX.Element {
	const [revealed, setRevealed] = useState(false);
	if (value === null || value === undefined)
		return <span className="grid-cell-null">NULL</span>;
	if (column.hidden && !revealed) {
		return (
			<span className="inline-flex items-center gap-1">
				<span className="text-muted-foreground">••••••</span>
				<button
					type="button"
					className="text-[11px] text-primary hover:underline"
					onClick={() => setRevealed(true)}
				>
					reveal
				</button>
			</span>
		);
	}
	if (isMarker(value) && value.__neoorm === "bytes") {
		return (
			<span className="inline-flex items-center gap-1">
				<span
					className={cn(
						wrap
							? "whitespace-pre-wrap break-words"
							: "block truncate",
					)}
				>
					{formatCell(value)}
				</span>
				<button
					type="button"
					className="text-[11px] text-primary hover:underline"
					onClick={() =>
						downloadBase64(value.base64 ?? "", column.tsName)
					}
				>
					download
				</button>
				{column.hidden ? (
					<button
						type="button"
						className="ml-1 text-[11px] text-muted-foreground hover:underline"
						onClick={() => setRevealed(false)}
					>
						hide
					</button>
				) : null}
			</span>
		);
	}
	const text = formatCell(value);
	const full = fullCellText(value);
	return (
		<span
			title={
				full.length > text.length || full !== text ? full : undefined
			}
			className={cn(
				wrap ? "whitespace-pre-wrap break-words" : "block truncate",
			)}
		>
			{text}
			{column.hidden ? (
				<button
					type="button"
					className="ml-1 text-[11px] text-muted-foreground hover:underline"
					onClick={() => setRevealed(false)}
				>
					hide
				</button>
			) : null}
		</span>
	);
}

function toLocalInput(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CellEditor({
	column,
	value,
	onCommit,
	onCancel,
}: {
	column: StudioColumnMeta;
	value: unknown;
	onCommit: (value: unknown) => void;
	onCancel: () => void;
}): React.JSX.Element {
	const [draft, setDraft] = useState<string>(() => {
		if (isMarker(value) && value.__neoorm === "bytes")
			return base64ToHex(value.base64 ?? "");
		return editText(value);
	});
	const inputFocus = useEditorFocus<HTMLInputElement>();
	const selectFocus = useEditorFocus<HTMLSelectElement>();
	const areaFocus = useEditorFocus<HTMLTextAreaElement>();
	const [bytesName, setBytesName] = useState<string | null>(null);

	const commitText = (text: string): void => {
		if (text === "" && column.nullable) {
			onCommit(null);
			return;
		}
		if (column.kind === "bool") {
			if (text === "true") onCommit(true);
			else if (text === "false") onCommit(false);
			else onCommit(null);
			return;
		}
		if (["int", "serial", "real", "double"].includes(column.kind)) {
			if (text.trim() === "") {
				onCommit(null);
				return;
			}
			const n = Number(text);
			onCommit(Number.isFinite(n) ? n : text);
			return;
		}
		onCommit(text);
	};

	if (column.kind === "bool") {
		const current =
			value === true ? "true" : value === false ? "false" : "";
		return (
			<Select
				ref={selectFocus}
				value={current}
				onChange={(e) => commitText(e.target.value)}
				onKeyDown={(e) => e.key === "Escape" && onCancel()}
			>
				<option value="">—</option>
				<option value="true">true</option>
				<option value="false">false</option>
				{column.nullable ? <option value="null">NULL</option> : null}
			</Select>
		);
	}

	const enums = enumValues(column);
	if (enums) {
		return (
			<Select
				ref={selectFocus}
				value={typeof value === "string" ? value : ""}
				onChange={(e) => commitText(e.target.value)}
				onKeyDown={(e) => e.key === "Escape" && onCancel()}
			>
				<option value="">—</option>
				{enums.map((v) => (
					<option key={v} value={v}>
						{v}
					</option>
				))}
			</Select>
		);
	}

	if (column.kind === "timestamp") {
		const initial =
			typeof value === "string"
				? value
				: ((value as { value?: string } | null)?.value ?? "");
		return (
			<input
				ref={inputFocus}
				type="datetime-local"
				className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:border-ring"
				defaultValue={initial ? toLocalInput(initial) : ""}
				onKeyDown={(e) => {
					if (e.key === "Escape") onCancel();
					if (e.key === "Enter")
						commitText((e.target as HTMLInputElement).value);
				}}
				onBlur={(e) => commitText(e.target.value)}
			/>
		);
	}

	if (column.kind === "date" || column.kind === "time") {
		return (
			<input
				ref={inputFocus}
				type={column.kind}
				className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:border-ring"
				defaultValue={typeof value === "string" ? value : ""}
				onKeyDown={(e) => {
					if (e.key === "Escape") onCancel();
					if (e.key === "Enter")
						commitText((e.target as HTMLInputElement).value);
				}}
				onBlur={(e) => commitText(e.target.value)}
			/>
		);
	}

	if (column.kind === "bytea") {
		const base64 =
			isMarker(value) && value.__neoorm === "bytes"
				? (value.base64 ?? "")
				: "";
		return (
			<div className="flex min-w-64 flex-col gap-1">
				<input
					type="file"
					className="text-xs"
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (!file) return;
						setBytesName(file.name);
						const reader = new FileReader();
						reader.onload = (): void => {
							const result = reader.result;
							if (typeof result !== "string") return;
							const next = result.split(",")[1] ?? "";
							onCommit({ __neoorm: "bytes", base64: next });
						};
						reader.readAsDataURL(file);
					}}
				/>
				<input
					ref={inputFocus}
					className="h-8 w-full rounded-md border border-input bg-transparent px-2 font-mono text-xs outline-none focus:border-ring"
					placeholder="hex…"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") onCancel();
						if (e.key === "Enter") {
							const hex = (e.target as HTMLInputElement).value;
							if (hex.trim() === "") {
								onCommit(column.nullable ? null : hex);
								return;
							}
							onCommit({
								__neoorm: "bytes",
								base64: hexToBase64(hex),
							});
						}
					}}
				/>
				{bytesName ? (
					<span className="text-[11px] text-muted-foreground">
						{bytesName}
					</span>
				) : null}
				<div className="flex gap-1">
					{base64 ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() =>
								downloadBase64(base64, column.tsName)
							}
						>
							Download
						</Button>
					) : null}
					<Button
						size="sm"
						variant="outline"
						onClick={() => commitText("")}
					>
						Set NULL
					</Button>
					<Button size="sm" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
				</div>
			</div>
		);
	}

	if (column.kind === "uuid" || column.kind === "id") {
		return (
			<div className="flex gap-1">
				<input
					ref={inputFocus}
					className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:border-ring"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") onCancel();
						if (e.key === "Enter") commitText(draft);
					}}
				/>
				<Button
					size="sm"
					variant="outline"
					title="Generate a UUID"
					onClick={() => {
						const id = crypto.randomUUID();
						setDraft(id);
						commitText(id);
					}}
				>
					Gen
				</Button>
			</div>
		);
	}

	if (isJsonKind(column.kind)) {
		return (
			<JsonCellEditor
				value={draft}
				onCommit={(text) => commitText(text)}
				onCancel={onCancel}
				nullable={column.nullable}
			/>
		);
	}

	if (
		column.kind.endsWith("Array") ||
		isGeoKind(column.kind) ||
		draft.length > 80 ||
		draft.includes("\n")
	) {
		return (
			<div className="flex min-w-64 flex-col gap-1">
				<Textarea
					ref={areaFocus}
					rows={4}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => e.key === "Escape" && onCancel()}
				/>
				<div className="flex gap-1">
					<Button size="sm" onClick={() => commitText(draft)}>
						Set
					</Button>
					{column.nullable ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => onCommit(null)}
						>
							NULL
						</Button>
					) : null}
					<Button size="sm" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
				</div>
			</div>
		);
	}

	return (
		<input
			ref={inputFocus}
			className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:border-ring"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Escape") onCancel();
				if (e.key === "Enter") commitText(draft);
			}}
			onBlur={() => commitText(draft)}
		/>
	);
}

/** Tiny dot preview for GeoJSON Point values (geometry/geography/point columns). */
export function GeoPreview({
	value,
}: {
	value: unknown;
}): React.JSX.Element | null {
	let point: [number, number] | null = null;
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		if (!text) return null;
		if (/^\s*POINT\s*\(/i.test(text)) {
			const m = text.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
			if (m?.[1] && m?.[2]) point = [Number(m[1]), Number(m[2])];
		} else {
			const parsed = JSON.parse(text) as {
				type?: string;
				coordinates?: unknown;
			};
			if (parsed.type === "Point" && Array.isArray(parsed.coordinates)) {
				const [x, y] = parsed.coordinates as [number, number];
				if (typeof x === "number" && typeof y === "number")
					point = [x, y];
			}
		}
	} catch {
		return null;
	}
	if (!point) return null;
	const [x, y] = point;
	return (
		<svg
			width="120"
			height="60"
			className="rounded border border-border bg-muted"
			aria-label={`Point ${x}, ${y}`}
		>
			<circle
				cx={10 + (Math.abs(x) % 100)}
				cy={10 + (Math.abs(y) % 40)}
				r="4"
				fill="var(--primary)"
			/>
			<text x="4" y="56" fontSize="8" fill="var(--muted-foreground)">
				{x}, {y}
			</text>
		</svg>
	);
}

function JsonCellEditor({
	value,
	onCommit,
	onCancel,
	nullable,
}: {
	value: string;
	onCommit: (text: string) => void;
	onCancel: () => void;
	nullable: boolean;
}): React.JSX.Element {
	const parentRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onCommitRef = useRef(onCommit);
	const onCancelRef = useRef(onCancel);
	onCommitRef.current = onCommit;
	onCancelRef.current = onCancel;
	const initialDoc = useRef(value);
	const dark = document.documentElement.classList.contains("dark");
	useEffect(() => {
		if (!parentRef.current) return;
		const view = new EditorView({
			state: EditorState.create({
				doc: initialDoc.current,
				extensions: [
					json(),
					keymap.of([
						...defaultKeymap,
						{
							key: "Escape",
							run: () => {
								onCancelRef.current();
								return true;
							},
						},
						{
							key: "Mod-Enter",
							run: (v) => {
								onCommitRef.current(v.state.doc.toString());
								return true;
							},
						},
					]),
					EditorView.lineWrapping,
					...(dark ? [oneDark] : []),
				],
			}),
			parent: parentRef.current,
		});
		viewRef.current = view;
		view.focus();
		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// Mount once; CodeMirror owns the document after that.
	}, [dark]);
	return (
		<div className="flex min-w-72 flex-col gap-1">
			<div ref={parentRef} className="min-h-24" />
			<div className="flex gap-1">
				<Button
					size="sm"
					onClick={() =>
						onCommit(viewRef.current?.state.doc.toString() ?? value)
					}
				>
					Set
				</Button>
				{nullable ? (
					<Button
						size="sm"
						variant="outline"
						onClick={() => onCommit("")}
					>
						NULL
					</Button>
				) : null}
				<Button size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function downloadBase64(base64: string, name: string): void {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	const blob = new Blob([bytes]);
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
}

function base64ToHex(base64: string): string {
	if (!base64) return "";
	const binary = atob(base64);
	let hex = "";
	for (let i = 0; i < binary.length; i++) {
		hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
	}
	return hex;
}

function hexToBase64(hex: string): string {
	const clean = hex.replace(/^\\x/i, "").replace(/[^0-9a-f]/gi, "");
	const bytes = new Uint8Array(Math.floor(clean.length / 2));
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}
