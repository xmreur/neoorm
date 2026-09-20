import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { api, type StudioMetaResponse, setToken } from "./api";

export type Route =
	| { view: "tables"; accessor: string | null; params: URLSearchParams }
	| { view: "sql" }
	| { view: "query" }
	| { view: "schema"; accessor: string | null }
	| { view: "er" }
	| { view: "migrate" };

export function parseHash(hash: string): Route {
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	const [path = "/", query = ""] = raw.split("?");
	const params = new URLSearchParams(query);
	const parts = path.split("/").filter((p) => p.length > 0);
	if (parts[0] === "tables")
		return {
			view: "tables",
			accessor: parts[1] ? decodeURIComponent(parts[1]) : null,
			params,
		};
	if (parts[0] === "sql") return { view: "sql" };
	if (parts[0] === "query") return { view: "query" };
	if (parts[0] === "schema")
		return {
			view: "schema",
			accessor: parts[1] ? decodeURIComponent(parts[1]) : null,
		};
	if (parts[0] === "er") return { view: "er" };
	if (parts[0] === "migrate") return { view: "migrate" };
	return { view: "tables", accessor: null, params };
}

export function navigate(to: string): void {
	window.location.hash = to;
}

export function tableLink(
	accessor: string,
	params?: { where?: unknown; q?: string; orderBy?: unknown },
): string {
	const search = new URLSearchParams();
	if (params?.where !== undefined)
		search.set("where", JSON.stringify(params.where));
	if (params?.q) search.set("q", params.q);
	if (params?.orderBy !== undefined)
		search.set("orderBy", JSON.stringify(params.orderBy));
	const suffix = search.toString();
	return `#/tables/${encodeURIComponent(accessor)}${suffix ? `?${suffix}` : ""}`;
}

type StudioState = {
	meta: StudioMetaResponse | null;
	metaError: string | null;
	refreshMeta: () => Promise<void>;
	route: Route;
	theme: "dark" | "light";
	toggleTheme: () => void;
	paletteOpen: boolean;
	setPaletteOpen: (open: boolean) => void;
	saveToken: (value: string) => void;
};

function consumeTokenFromUrl(): void {
	const params = new URLSearchParams(window.location.search);
	const fromQuery = params.get("token");
	if (!fromQuery) return;
	setToken(fromQuery);
	params.delete("token");
	const search = params.toString();
	window.history.replaceState(
		null,
		"",
		`${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
	);
}

const StudioContext = createContext<StudioState | null>(null);

export function StudioProvider({
	children,
}: {
	children: ReactNode;
}): React.JSX.Element {
	useState(() => {
		consumeTokenFromUrl();
		return null;
	});
	const [meta, setMeta] = useState<StudioMetaResponse | null>(null);
	const [metaError, setMetaError] = useState<string | null>(null);
	const [route, setRoute] = useState<Route>(() =>
		parseHash(window.location.hash),
	);
	const [theme, setTheme] = useState<"dark" | "light">(() =>
		localStorage.getItem("neoorm-studio-theme") === "light"
			? "light"
			: "dark",
	);
	const [paletteOpen, setPaletteOpen] = useState(false);

	const refreshMeta = useCallback(async () => {
		try {
			const loaded = await api.meta();
			setMeta(loaded);
			setMetaError(null);
		} catch (err) {
			setMetaError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void refreshMeta();
	}, [refreshMeta]);

	useEffect(() => {
		const onHash = (): void => setRoute(parseHash(window.location.hash));
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	useEffect(() => {
		document.documentElement.classList.toggle("dark", theme === "dark");
		localStorage.setItem("neoorm-studio-theme", theme);
	}, [theme]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setPaletteOpen((v) => !v);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const toggleTheme = useCallback(
		() => setTheme((t) => (t === "dark" ? "light" : "dark")),
		[],
	);
	const saveToken = useCallback(
		(value: string) => {
			setToken(value);
			void refreshMeta();
		},
		[refreshMeta],
	);

	const value = useMemo<StudioState>(
		() => ({
			meta,
			metaError,
			refreshMeta,
			route,
			theme,
			toggleTheme,
			paletteOpen,
			setPaletteOpen,
			saveToken,
		}),
		[
			meta,
			metaError,
			refreshMeta,
			route,
			theme,
			toggleTheme,
			paletteOpen,
			saveToken,
		],
	);
	return (
		<StudioContext.Provider value={value}>
			{children}
		</StudioContext.Provider>
	);
}

export function useStudio(): StudioState {
	const ctx = useContext(StudioContext);
	if (!ctx) throw new Error("useStudio must be used inside StudioProvider");
	return ctx;
}
