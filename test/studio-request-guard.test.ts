import { describe, expect, it } from "vitest";
import {
	isAllowedStudioHostHeader,
	isAllowedStudioHostname,
	isAllowedStudioOrigin,
	isJsonContentType,
	isLoopbackHostname,
	parseHostHeader,
} from "../src/studio/request-guard.js";

const bind = { host: "127.0.0.1", port: 7584 };

describe("studio request guard", () => {
	it("treats localhost and loopback IPs as loopback", () => {
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
		expect(isLoopbackHostname("LOCALHOST.")).toBe(true);
		expect(isLoopbackHostname("[::1]")).toBe(true);
		expect(isLoopbackHostname("0.0.0.0")).toBe(false);
		expect(isLoopbackHostname("evil.example")).toBe(false);
	});

	it("parses Host including bracketed IPv6", () => {
		expect(parseHostHeader("127.0.0.1:7584")).toEqual({
			hostname: "127.0.0.1",
			port: "7584",
		});
		expect(parseHostHeader("[::1]:7584")).toEqual({
			hostname: "::1",
			port: "7584",
		});
		expect(parseHostHeader("evil.example:7584")).toEqual({
			hostname: "evil.example",
			port: "7584",
		});
		expect(parseHostHeader("")).toBeNull();
		expect(parseHostHeader("127.0.0.1:7584/api")).toBeNull();
	});

	it("allows loopback Host on the listen port and rejects DNS-rebind names", () => {
		expect(isAllowedStudioHostHeader("127.0.0.1:7584", bind)).toBe(true);
		expect(isAllowedStudioHostHeader("localhost:7584", bind)).toBe(true);
		expect(isAllowedStudioHostHeader("[::1]:7584", bind)).toBe(true);
		expect(isAllowedStudioHostHeader("127.0.0.1:80", bind)).toBe(false);
		expect(isAllowedStudioHostHeader("evil.example:7584", bind)).toBe(
			false,
		);
		expect(isAllowedStudioHostHeader(undefined, bind)).toBe(false);
	});

	it("allows literal IPs when bound on 0.0.0.0, not hostnames", () => {
		const all = { host: "0.0.0.0", port: 7584 };
		expect(isAllowedStudioHostHeader("10.0.0.8:7584", all)).toBe(true);
		expect(isAllowedStudioHostHeader("127.0.0.1:7584", all)).toBe(true);
		expect(isAllowedStudioHostHeader("evil.example:7584", all)).toBe(false);
		expect(isAllowedStudioHostname("evil.example", "0.0.0.0")).toBe(false);
	});

	it("rejects cross-site Origin and null Origin, allows missing and loopback", () => {
		expect(isAllowedStudioOrigin(undefined, bind)).toBe(true);
		expect(isAllowedStudioOrigin("http://127.0.0.1:7584", bind)).toBe(true);
		expect(isAllowedStudioOrigin("http://localhost:7584", bind)).toBe(true);
		expect(isAllowedStudioOrigin("https://evil.example", bind)).toBe(false);
		expect(isAllowedStudioOrigin("http://evil.example:7584", bind)).toBe(
			false,
		);
		expect(isAllowedStudioOrigin("null", bind)).toBe(false);
		expect(isAllowedStudioOrigin("http://127.0.0.1:7584/extra", bind)).toBe(
			false,
		);
	});

	it("accepts application/json with parameters and rejects other types", () => {
		expect(isJsonContentType("application/json")).toBe(true);
		expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
		expect(isJsonContentType("APPLICATION/JSON")).toBe(true);
		expect(isJsonContentType("text/plain")).toBe(false);
		expect(isJsonContentType("application/x-www-form-urlencoded")).toBe(
			false,
		);
		expect(isJsonContentType(undefined)).toBe(false);
	});
});
