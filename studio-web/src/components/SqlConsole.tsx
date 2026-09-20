import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
	MySQL,
	PostgreSQL,
	SQLite,
	StandardSQL,
	sql,
} from "@codemirror/lang-sql";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type StudioMetaResponse } from "../api";
import { useStudio } from "../state";
import { ResultTable } from "./ResultTable";
import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Empty,
	Field,
	Spinner,
	Textarea,
} from "./ui";

const HISTORY_KEY = "neoorm-studio-sql-history";

function loadHistory(): string[] {
	try {
		return JSON.parse(
			localStorage.getItem(HISTORY_KEY) ?? "[]",
		) as string[];
	} catch {
		return [];
	}
}

function dialectFor(
	meta: StudioMetaResponse,
): "pg" | "mysql" | "sqlite" | "std" {
	if (meta.dialect === "postgresql") return "pg";
	if (meta.dialect === "mysql" || meta.dialect === "mariadb") return "mysql";
	if (meta.dialect === "sqlite") return "sqlite";
	return "std";
}

export function SqlConsole({
	meta,
}: {
	meta: StudioMetaResponse;
}): React.JSX.Element {
	const [text, setText] = useState("SELECT 1;");
	const [paramsText, setParamsText] = useState("");
	const [explain, setExplain] = useState(false);
	const [analyze, setAnalyze] = useState(false);
	const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
	const [rowCount, setRowCount] = useState<number | null>(null);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [queryHistory, setQueryHistory] = useState<string[]>(loadHistory);
	const editorRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const langCompartment = useRef(new Compartment());
	const themeCompartment = useRef(new Compartment());
	const runRef = useRef<(sqlText: string) => Promise<void>>(
		async () => undefined,
	);
	const { theme } = useStudio();
	const dark = theme === "dark";

	const schema = useMemo(() => {
		const tables: Record<string, string[]> = {};
		for (const t of Object.values(meta.tables)) {
			tables[t.sqlName] = t.columns.map((c) => c.sqlName);
		}
		return tables;
	}, [meta]);

	const dialect = dialectFor(meta);
	const initialDoc = useRef(text);
	const initialDialect = useRef(dialect);
	const initialSchema = useRef(schema);
	const initialDark = useRef(dark);

	useEffect(() => {
		if (!editorRef.current || viewRef.current) return;
		const startDialect = initialDialect.current;
		const lang =
			startDialect === "pg"
				? PostgreSQL
				: startDialect === "mysql"
					? MySQL
					: startDialect === "sqlite"
						? SQLite
						: StandardSQL;
		const state = EditorState.create({
			doc: initialDoc.current,
			extensions: [
				history(),
				keymap.of([
					...defaultKeymap,
					...historyKeymap,
					{
						key: "Mod-Enter",
						run: (view) => {
							void runRef.current(view.state.doc.toString());
							return true;
						},
					},
				]),
				langCompartment.current.of(
					sql({ dialect: lang, schema: initialSchema.current }),
				),
				themeCompartment.current.of(initialDark.current ? oneDark : []),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) setText(update.state.doc.toString());
				}),
				EditorView.lineWrapping,
			],
		});
		const view = new EditorView({ state, parent: editorRef.current });
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, []);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const lang =
			dialect === "pg"
				? PostgreSQL
				: dialect === "mysql"
					? MySQL
					: dialect === "sqlite"
						? SQLite
						: StandardSQL;
		view.dispatch({
			effects: langCompartment.current.reconfigure(
				sql({ dialect: lang, schema }),
			),
		});
	}, [dialect, schema]);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: themeCompartment.current.reconfigure(dark ? oneDark : []),
		});
	}, [dark]);

	const run = async (sqlText: string): Promise<void> => {
		setRunning(true);
		setError(null);
		try {
			let params: unknown[] = [];
			if (paramsText.trim()) {
				try {
					params = JSON.parse(paramsText) as unknown[];
				} catch {
					throw new Error("Params must be a JSON array");
				}
				if (!Array.isArray(params))
					throw new Error("Params must be a JSON array");
			}
			const result = await api.sql({
				text: sqlText,
				params,
				...(analyze
					? { explain: "analyze" }
					: explain
						? { explain: true }
						: {}),
			});
			setRows(result.rows);
			setRowCount(result.rowCount);
			setQueryHistory((h) => {
				const next = [sqlText, ...h.filter((x) => x !== sqlText)].slice(
					0,
					20,
				);
				localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
				return next;
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setRows(null);
			setRowCount(null);
		} finally {
			setRunning(false);
		}
	};

	runRef.current = run;

	return (
		<div className="flex h-full flex-col gap-2 p-3">
			<div className="flex items-center gap-2">
				<h1 className="text-base font-semibold">SQL console</h1>
				<span className="text-xs text-muted-foreground">
					Dialect: {meta.dialect} • params use $1/$2 (pg, sqlite) or ?
					(mysql)
				</span>
				<div className="ml-auto flex items-center gap-2 text-xs">
					<label className="flex items-center gap-1">
						<input
							type="checkbox"
							checked={explain}
							onChange={(e) => setExplain(e.target.checked)}
						/>{" "}
						EXPLAIN
					</label>
					<label className="flex items-center gap-1">
						<input
							type="checkbox"
							checked={analyze}
							onChange={(e) => setAnalyze(e.target.checked)}
						/>{" "}
						ANALYZE
					</label>
					<Button
						size="sm"
						disabled={running}
						onClick={() =>
							void run(
								viewRef.current?.state.doc.toString() ?? text,
							)
						}
					>
						{running ? "Running…" : "Run (⌘↵)"}
					</Button>
				</div>
			</div>
			<div ref={editorRef} className="min-h-32" />
			<div className="flex gap-2">
				<Field label="Params (JSON array, optional)">
					<Textarea
						rows={1}
						className="w-96"
						placeholder='["alice@example.com"]'
						value={paramsText}
						onChange={(e) => setParamsText(e.target.value)}
					/>
				</Field>
				{queryHistory.length > 0 ? (
					<Field label="History">
						<select
							className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
							defaultValue=""
							onChange={(e) => {
								if (!e.target.value) return;
								viewRef.current?.dispatch({
									changes: {
										from: 0,
										to: viewRef.current.state.doc.length,
										insert: e.target.value,
									},
								});
								setText(e.target.value);
								e.target.value = "";
							}}
						>
							<option value="">Load previous query…</option>
							{queryHistory.map((h, i) => (
								<option
									// biome-ignore lint/suspicious/noArrayIndexKey: history entries can repeat; position is the identity
									key={i}
									value={h}
								>
									{h.slice(0, 80)}
								</option>
							))}
						</select>
					</Field>
				) : null}
			</div>
			{error ? (
				<Card>
					<CardHeader>
						<CardTitle>Error</CardTitle>
					</CardHeader>
					<CardContent>
						<pre className="mono text-xs whitespace-pre-wrap text-destructive">
							{error}
						</pre>
					</CardContent>
				</Card>
			) : null}
			{running ? (
				<p className="text-xs text-muted-foreground">
					<Spinner /> Running…
				</p>
			) : null}
			{rows !== null ? (
				<div className="flex min-h-0 flex-1 flex-col gap-1">
					<span className="text-xs text-muted-foreground">
						{rowCount ?? rows.length} row(s)
					</span>
					<div className="min-h-0 flex-1 overflow-auto">
						<ResultTable rows={rows} />
					</div>
				</div>
			) : !error ? (
				<Empty
					title="Run a query"
					hint="Results appear here. Use ⌘/Ctrl+Enter to run from the editor."
				/>
			) : null}
		</div>
	);
}
