import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { StudioProvider } from "./state";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
	<StrictMode>
		<StudioProvider>
			<App />
		</StudioProvider>
	</StrictMode>,
);
