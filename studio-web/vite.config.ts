import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [react(), tailwindcss()],
	base: "./",
	build: {
		outDir: "../dist/studio-ui",
		emptyOutDir: true,
		chunkSizeWarningLimit: 1200,
	},
	server: {
		port: 7585,
		proxy: {
			"/api": "http://127.0.0.1:7584",
		},
	},
});
