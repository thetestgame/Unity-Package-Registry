/** Shared helpers: JSON responses, package-name parsing, and base64 encode/decode. */

export function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(data), { ...init, headers });
}

export function notFound(message = "Not found"): Response {
	return json({ error: message }, { status: 404 });
}

export function badRequest(message: string): Response {
	return json({ error: message }, { status: 400 });
}

export function unauthorized(message = "Unauthorized"): Response {
	return json({ error: message }, {
		status: 401,
		headers: { "WWW-Authenticate": 'Bearer realm="npm"' },
	});
}

/**
 * Split a request pathname into decoded segments. Scoped package names are
 * sent as a single percent-encoded segment (e.g. `@scope%2fname`), so we
 * must decode *after* splitting on literal `/` characters, never before.
 */
export function splitPath(pathname: string): string[] {
	return pathname
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => decodeURIComponent(segment));
}

/** Encode a package name for use as a single URL path segment. */
export function encodePackageName(name: string): string {
	return encodeURIComponent(name).replace(/^%40/, "@");
}

const HEX = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) {
		out += HEX.charAt(b >> 4) + HEX.charAt(b & 0x0f);
	}
	return out;
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", data);
	return bytesToHex(new Uint8Array(digest));
}

export async function sha512Base64(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-512", data);
	return arrayBufferToBase64(digest);
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}
