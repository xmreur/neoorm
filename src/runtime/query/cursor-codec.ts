const CURSOR_CODEC_VERSION = 1;

type EncodedCursorPayload = {
	v: number;
	c: Record<string, unknown>;
};

export function encodeCursor(cursor: Record<string, unknown>): string {
	const payload: EncodedCursorPayload = {
		v: CURSOR_CODEC_VERSION,
		c: cursor,
	};
	return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

export function decodeCursor<
	T extends Record<string, unknown> = Record<string, unknown>,
>(encoded: string): T {
	let parsed: unknown;
	try {
		const json = Buffer.from(encoded, "base64url").toString("utf-8");
		parsed = JSON.parse(json);
	} catch {
		throw new Error("Invalid cursor encoding");
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("v" in parsed) ||
		!("c" in parsed) ||
		(parsed as EncodedCursorPayload).v !== CURSOR_CODEC_VERSION ||
		typeof (parsed as EncodedCursorPayload).c !== "object" ||
		(parsed as EncodedCursorPayload).c === null ||
		Array.isArray((parsed as EncodedCursorPayload).c)
	) {
		throw new Error("Invalid cursor payload");
	}

	return (parsed as EncodedCursorPayload).c as T;
}
