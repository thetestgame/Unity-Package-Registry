import { unauthorized } from "./utils";

/** Parses env.AUTH_TOKENS ("tok1,tok2") into a Set, ignoring blanks/whitespace. */
function parseTokens(raw: string | undefined): Set<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t.length > 0),
	);
}

function extractBearerToken(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match?.[1]?.trim() ?? null;
}

/**
 * Constant-time membership check against the configured token set.
 * Avoids leaking token length/content via early-exit string comparison.
 */
async function tokenIsValid(token: string, validTokens: Set<string>): Promise<boolean> {
	const encoder = new TextEncoder();
	const candidate = await crypto.subtle.digest("SHA-256", encoder.encode(token));
	const candidateHex = Array.from(new Uint8Array(candidate))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	let matched = false;
	for (const valid of validTokens) {
		const validDigest = await crypto.subtle.digest("SHA-256", encoder.encode(valid));
		const validHex = Array.from(new Uint8Array(validDigest))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		if (validHex === candidateHex) matched = true;
	}
	return matched;
}

export interface AuthResult {
	authenticated: boolean;
	token: string | null;
}

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
	const validTokens = parseTokens(env.AUTH_TOKENS);
	const token = extractBearerToken(request);
	if (!token || validTokens.size === 0) {
		return { authenticated: false, token };
	}
	return { authenticated: await tokenIsValid(token, validTokens), token };
}

/** Require a valid bearer token; returns an error Response to send, or null if allowed. */
export async function requireAuth(request: Request, env: Env): Promise<Response | null> {
	const result = await authenticate(request, env);
	if (!result.authenticated) {
		return unauthorized("Valid bearer token required");
	}
	return null;
}

/** Reads are open by default; set REQUIRE_AUTH_FOR_READ=true to lock them down too. */
export async function requireReadAuth(request: Request, env: Env): Promise<Response | null> {
	if ((env.REQUIRE_AUTH_FOR_READ as string) !== "true") return null;
	return requireAuth(request, env);
}
