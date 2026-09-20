import { useMemo, useState } from "react";
import { api, type StudioMetaResponse } from "../api";
import { ResultTable } from "./ResultTable";
import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Empty,
	Field,
	Input,
	Select,
	Spinner,
	Textarea,
} from "./ui";

const METHODS = [
	"findMany",
	"findFirst",
	"findUnique",
	"findById",
	"count",
	"exists",
	"aggregate",
	"groupBy",
	"paginate",
] as const;

type Method = (typeof METHODS)[number];

function parseJsonObject(text: string, label: string): Record<string, unknown> {
	if (!text.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		)
			throw new Error("must be an object");
		return parsed as Record<string, unknown>;
	} catch (err) {
		throw new Error(
			`${label}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Render args as TypeScript (`db.users.findMany({ ... })`) with accessors. */
export function toTypeScript(
	accessor: string,
	method: string,
	args: Record<string, unknown>,
): string {
	const render = (value: unknown, indent: string): string => {
		if (value === null || value === undefined) return "null";
		if (typeof value === "string") return JSON.stringify(value);
		if (typeof value === "number" || typeof value === "boolean")
			return String(value);
		if (Array.isArray(value)) {
			if (value.length === 0) return "[]";
			return `[\n${value.map((v) => `${indent}  ${render(v, `${indent}  `)},`).join("\n")}\n${indent}]`;
		}
		if (typeof value === "object") {
			const entries = Object.entries(value as Record<string, unknown>);
			if (entries.length === 0) return "{}";
			const safe = (k: string): string =>
				/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
			return `{\n${entries.map(([k, v]) => `${indent}  ${safe(k)}: ${render(v, `${indent}  `)},`).join("\n")}\n${indent}}`;
		}
		return "undefined";
	};
	const keys = Object.keys(args);
	const body =
		keys.length === 0
			? ""
			: ` ${render(args, "").slice(2, -1).replace(/\n$/, "")} `;
	return `await db.${accessor}.${method}({${body}});`;
}

export function QueryPlayground({
	meta,
}: {
	meta: StudioMetaResponse;
}): React.JSX.Element {
	const accessors = useMemo(() => Object.keys(meta.tables).sort(), [meta]);
	const [accessor, setAccessor] = useState(accessors[0] ?? "");
	const [method, setMethod] = useState<Method>("findMany");
	const [where, setWhere] = useState("{\n  \n}");
	const [withArg, setWithArg] = useState("");
	const [orderBy, setOrderBy] = useState("");
	const [select, setSelect] = useState("");
	const [extra, setExtra] = useState("");
	const [id, setId] = useState("");
	const [take, setTake] = useState("20");
	const [skip, setSkip] = useState("");
	const [result, setResult] = useState<{
		kind: "rows" | "value";
		rows?: Record<string, unknown>[];
		value?: unknown;
	} | null>(null);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	const buildArgs = (): Record<string, unknown> => {
		const args: Record<string, unknown> = {};
		const whereObj = parseJsonObject(where, "where");
		if (Object.keys(whereObj).length > 0) args.where = whereObj;
		const withObj = parseJsonObject(withArg, "with");
		if (Object.keys(withObj).length > 0) args.with = withObj;
		const orderObj = parseJsonObject(orderBy, "orderBy");
		if (Object.keys(orderObj).length > 0) args.orderBy = orderObj;
		if (select.trim())
			args.select = select
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		const extraObj = parseJsonObject(
			extra,
			method === "groupBy" ? "aggregations/by/having" : "extra",
		);
		Object.assign(args, extraObj);
		if (
			method === "findMany" ||
			method === "paginate" ||
			method === "groupBy"
		) {
			if (take.trim()) args.take = Number(take);
			if (skip.trim()) args.skip = Number(skip);
		}
		if (method === "findFirst" && skip.trim()) args.skip = Number(skip);
		if (method === "findById") {
			if (!id.trim()) throw new Error("findById needs `id`");
			try {
				args.id = JSON.parse(id) as unknown;
			} catch {
				args.id = id.trim();
			}
		}
		return args;
	};

	const run = async (): Promise<void> => {
		setRunning(true);
		setError(null);
		try {
			const args = buildArgs();
			const res = await api.query({ accessor, method, args });
			if (res.rows) setResult({ kind: "rows", rows: res.rows });
			else if (res.items) setResult({ kind: "rows", rows: res.items });
			else if (res.row !== undefined)
				setResult({ kind: "rows", rows: res.row ? [res.row] : [] });
			else setResult({ kind: "value", value: res.result });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setResult(null);
		} finally {
			setRunning(false);
		}
	};

	let preview = "";
	let previewError: string | null = null;
	try {
		preview = toTypeScript(accessor, method, buildArgs());
	} catch (err) {
		previewError = err instanceof Error ? err.message : String(err);
	}

	return (
		<div className="flex h-full flex-col gap-2 overflow-auto p-3">
			<div className="flex items-center gap-2">
				<h1 className="text-base font-semibold">Query playground</h1>
				<span className="text-xs text-muted-foreground">
					Runs through the NeoOrm client — copy any working query as
					TypeScript.
				</span>
			</div>
			<div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Query</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex flex-col gap-2">
							<div className="flex gap-2">
								<Field label="Table">
									<Select
										value={accessor}
										onChange={(e) =>
											setAccessor(e.target.value)
										}
									>
										{accessors.map((a) => (
											<option key={a} value={a}>
												{a}
											</option>
										))}
									</Select>
								</Field>
								<Field label="Method">
									<Select
										value={method}
										onChange={(e) =>
											setMethod(e.target.value as Method)
										}
									>
										{METHODS.map((m) => (
											<option key={m} value={m}>
												{m}
											</option>
										))}
									</Select>
								</Field>
								{method === "findById" ? (
									<Field label="id (string or JSON object)">
										<Input
											className="mono"
											value={id}
											onChange={(e) =>
												setId(e.target.value)
											}
											placeholder='"abc" or {"a": 1}'
										/>
									</Field>
								) : null}
								{(method === "findMany" ||
									method === "paginate" ||
									method === "groupBy") && (
									<>
										<Field label="take">
											<Input
												className="mono w-20"
												value={take}
												onChange={(e) =>
													setTake(e.target.value)
												}
											/>
										</Field>
										<Field label="skip">
											<Input
												className="mono w-20"
												value={skip}
												onChange={(e) =>
													setSkip(e.target.value)
												}
											/>
										</Field>
									</>
								)}
								{method === "findFirst" && (
									<Field label="skip">
										<Input
											className="mono w-20"
											value={skip}
											onChange={(e) =>
												setSkip(e.target.value)
											}
										/>
									</Field>
								)}
							</div>
							{method !== "findById" ? (
								<Field label="where (JSON)">
									<Textarea
										rows={4}
										value={where}
										onChange={(e) =>
											setWhere(e.target.value)
										}
										placeholder='{"published": true}'
									/>
								</Field>
							) : null}
							<div className="grid grid-cols-2 gap-2">
								<Field label="with (JSON)">
									<Textarea
										rows={3}
										value={withArg}
										onChange={(e) =>
											setWithArg(e.target.value)
										}
										placeholder='{"author": true}'
									/>
								</Field>
								<Field label="orderBy (JSON)">
									<Textarea
										rows={3}
										value={orderBy}
										onChange={(e) =>
											setOrderBy(e.target.value)
										}
										placeholder='{"createdAt": "desc"}'
									/>
								</Field>
							</div>
							<div className="grid grid-cols-2 gap-2">
								<Field label="select (comma-separated)">
									<Input
										className="mono"
										value={select}
										onChange={(e) =>
											setSelect(e.target.value)
										}
										placeholder="id, email"
									/>
								</Field>
								<Field
									label={
										method === "groupBy"
											? 'by + aggregations (JSON: {"by": [...], "_count": true})'
											: method === "aggregate"
												? 'aggregations (JSON: {"_count": true, "_avg": {...}})'
												: method === "paginate"
													? "cursors (JSON: after/before)"
													: "extra args (JSON)"
									}
								>
									<Textarea
										rows={2}
										value={extra}
										onChange={(e) =>
											setExtra(e.target.value)
										}
										placeholder={
											method === "groupBy"
												? '{"by": ["status"], "_count": true}'
												: method === "aggregate"
													? '{"_count": true}'
													: "{}"
										}
									/>
								</Field>
							</div>
							<div className="flex gap-2">
								<Button
									disabled={running}
									onClick={() => void run()}
								>
									{running ? "Running…" : "Run"}
								</Button>
								<Button
									variant="outline"
									disabled={previewError !== null}
									onClick={() => {
										void navigator.clipboard.writeText(
											`import { db } from "./neoorm/client.js";\n\nconst result = ${preview}\n`,
										);
										setCopied(true);
										setTimeout(
											() => setCopied(false),
											1500,
										);
									}}
								>
									{copied ? "Copied!" : "Copy as TypeScript"}
								</Button>
							</div>
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>TypeScript preview</CardTitle>
					</CardHeader>
					<CardContent>
						{previewError ? (
							<p className="text-xs text-destructive">
								{previewError}
							</p>
						) : (
							<pre className="mono max-h-96 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
								{preview}
							</pre>
						)}
					</CardContent>
				</Card>
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
			{result ? (
				result.kind === "rows" ? (
					<ResultTable rows={result.rows ?? []} />
				) : (
					<pre className="mono overflow-auto rounded-md border border-border p-3 text-xs">
						{JSON.stringify(result.value, null, 2)}
					</pre>
				)
			) : !error && !running ? (
				<Empty
					title="Build a query and press Run"
					hint="findMany, aggregates, groupBy and cursor paginate all run through the same client your app uses."
				/>
			) : null}
		</div>
	);
}
