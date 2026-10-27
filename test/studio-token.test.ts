import { describe, expect, it } from "vitest";
import { browserOpenUrl } from "../src/studio/open-browser.js";
import { tokensMatch } from "../src/studio/token.js";

describe("studio token", () => {
	it("compares equal tokens and rejects different lengths", () => {
		expect(tokensMatch("studio-secret", "studio-secret")).toBe(true);
		expect(tokensMatch("studio-secret", "studio-secreT")).toBe(false);
		expect(tokensMatch("short", "studio-secret")).toBe(false);
		expect(tokensMatch("", "studio-secret")).toBe(false);
	});

	it("strips token from the browser open URL", () => {
		expect(browserOpenUrl("http://127.0.0.1:7584/?token=secret&x=1")).toBe(
			"http://127.0.0.1:7584/?x=1",
		);
		expect(browserOpenUrl("http://127.0.0.1:7584/")).toBe(
			"http://127.0.0.1:7584/",
		);
	});
});
