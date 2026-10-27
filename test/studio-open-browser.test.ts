import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBrowser } from "../src/studio/open-browser.js";

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

function fakeChild(): EventEmitter & { unref: ReturnType<typeof vi.fn> } {
	const child = new EventEmitter() as EventEmitter & {
		unref: ReturnType<typeof vi.fn>;
	};
	child.unref = vi.fn();
	return child;
}

describe("openBrowser", () => {
	afterEach(() => {
		spawnMock.mockReset();
		vi.restoreAllMocks();
	});

	it("reports ENOENT instead of leaving the error unhandled", () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		openBrowser("http://127.0.0.1:7584/?token=secret");
		const command = spawnMock.mock.calls[0]?.[0];
		expect(typeof command).toBe("string");
		expect(spawnMock.mock.calls[0]?.[1]).not.toContain("token=secret");
		child.emit(
			"error",
			Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
		);
		expect(logged).toHaveBeenCalledOnce();
		expect(String(logged.mock.calls[0]?.[0])).toContain(
			`${String(command)} was not found`,
		);
		expect(child.unref).toHaveBeenCalledOnce();
	});
});
