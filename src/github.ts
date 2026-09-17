import { encodePackageName } from "./utils";

const GITHUB_REGISTRY_BASE = "https://npm.pkg.github.com";
const DEFAULT_TTL_SECONDS = 300;
const USER_AGENT = "cloudflare-npm-registry-github-proxy";

interface GithubMirrorCache {
	cachedAt: string;
	/** Raw, unmodified packument as returned by npm.pkg.github.com. */
	packument: GithubPackument;
}

interface GithubPackument {
	name: string;
	"dist-tags"?: Record<string, string>;
	versions?: Record<string, GithubVersionManifest>;
	[key: string]: unknown;
}

interface GithubVersionManifest {
	dist?: { tarball?: string; [key: string]: unknown };
	[key: string]: unknown;
}

function scopeOf(name: string): string | null {
	const match = /^(@[^/]+)\//.exec(name);
	return match?.[1] ?? null;
}

/** True when the worker is configured with a GitHub token and at least one proxied scope. */
export function isGithubProxyConfigured(env: Env): boolean {
	return Boolean(env.GITHUB_TOKEN) && Boolean(env.GITHUB_PROXY_SCOPES);
}

/** True when `name`'s npm scope (e.g. `@owner`) is configured to proxy through GitHub Packages. */
export function isGithubProxiedScope(name: string, env: Env): boolean {
	const scope = scopeOf(name);
	if (!scope) return false;
	const scopes = (env.GITHUB_PROXY_SCOPES ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return scopes.includes(scope);
}

function mirrorKey(name: string): string {
	return `github-mirror/${name}.json`;
}

function ttlSeconds(env: Env): number {
	const raw = env.GITHUB_MIRROR_TTL_SECONDS as string | undefined;
	const parsed = raw ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_SECONDS;
}

function isFresh(cache: GithubMirrorCache, env: Env): boolean {
	const ageMs = Date.now() - Date.parse(cache.cachedAt);
	return Number.isFinite(ageMs) && ageMs < ttlSeconds(env) * 1000;
}

async function readMirrorCache(bucket: R2Bucket, name: string): Promise<GithubMirrorCache | null> {
	const obj = await bucket.get(mirrorKey(name));
	if (!obj) return null;
	return obj.json<GithubMirrorCache>();
}

async function writeMirrorCache(bucket: R2Bucket, name: string, packument: GithubPackument): Promise<void> {
	const entry: GithubMirrorCache = { cachedAt: new Date().toISOString(), packument };
	await bucket.put(mirrorKey(name), JSON.stringify(entry), {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
	});
}

async function fetchUpstreamPackument(name: string, env: Env): Promise<GithubPackument | null> {
	const res = await fetch(`${GITHUB_REGISTRY_BASE}/${encodePackageName(name)}`, {
		headers: {
			Authorization: `token ${env.GITHUB_TOKEN}`,
			Accept: "application/json",
			"User-Agent": USER_AGENT,
		},
	});
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`GitHub Packages request failed for "${name}": ${res.status} ${res.statusText}`);
	}
	return res.json();
}

function tarballFilename(tarballUrl: string | undefined): string | null {
	if (!tarballUrl) return null;
	try {
		const segments = new URL(tarballUrl).pathname.split("/").filter(Boolean);
		return segments.at(-1) ?? null;
	} catch {
		return null;
	}
}

/** Rewrites every version's `dist.tarball` to point back at this worker instead of GitHub. */
function rewriteForClient(raw: GithubPackument, name: string, origin: string): Record<string, unknown> {
	const rewrittenVersions: Record<string, unknown> = {};
	for (const [version, manifest] of Object.entries(raw.versions ?? {})) {
		const filename = tarballFilename(manifest.dist?.tarball);
		rewrittenVersions[version] = filename
			? { ...manifest, dist: { ...manifest.dist, tarball: `${origin}/${encodePackageName(name)}/-/${filename}` } }
			: manifest;
	}
	return { ...raw, versions: rewrittenVersions };
}

/**
 * Fetches (and R2-caches) a GitHub Packages packument, rewriting tarball URLs
 * to route through this worker. Falls back to a stale cache entry if GitHub
 * is temporarily unreachable. Returns null if the package doesn't exist
 * upstream.
 */
export async function getGithubMirrorPackument(
	bucket: R2Bucket,
	name: string,
	origin: string,
	env: Env,
): Promise<Record<string, unknown> | null> {
	const cached = await readMirrorCache(bucket, name);
	if (cached && isFresh(cached, env)) {
		return rewriteForClient(cached.packument, name, origin);
	}

	try {
		const upstream = await fetchUpstreamPackument(name, env);
		if (!upstream) return null;
		await writeMirrorCache(bucket, name, upstream);
		return rewriteForClient(upstream, name, origin);
	} catch (err) {
		console.error("GitHub Packages upstream fetch failed", err);
		if (cached) return rewriteForClient(cached.packument, name, origin);
		throw err;
	}
}

function findUpstreamTarballUrl(raw: GithubPackument, filename: string): string | null {
	for (const manifest of Object.values(raw.versions ?? {})) {
		const tarball = manifest.dist?.tarball;
		if (typeof tarball === "string" && tarball.endsWith(`/${filename}`)) return tarball;
	}
	return null;
}

async function mirrorTarballToR2(bucket: R2Bucket, name: string, filename: string, stream: ReadableStream): Promise<void> {
	try {
		await bucket.put(`tarballs/${name}/${filename}`, stream, {
			httpMetadata: { contentType: "application/octet-stream" },
		});
	} catch (err) {
		console.error("Failed to mirror GitHub Packages tarball into R2", err);
	}
}

/**
 * Streams a tarball for a GitHub-Packages-backed package straight from
 * GitHub using the worker's own token, so the client never needs (or sees) a
 * GitHub credential. This also sidesteps the redirect-plus-auth-header bugs
 * some clients (including Unity) hit against GitHub Packages directly,
 * since the worker follows GitHub's tarball redirect itself. Successful
 * fetches are lazily mirrored into R2 so future requests skip GitHub
 * entirely.
 */
export async function proxyGithubTarball(
	bucket: R2Bucket,
	name: string,
	filename: string,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response | null> {
	let cached = await readMirrorCache(bucket, name);
	let tarballUrl = cached ? findUpstreamTarballUrl(cached.packument, filename) : null;

	if (!tarballUrl) {
		const fresh = await fetchUpstreamPackument(name, env);
		if (!fresh) return null;
		await writeMirrorCache(bucket, name, fresh);
		cached = { cachedAt: new Date().toISOString(), packument: fresh };
		tarballUrl = findUpstreamTarballUrl(fresh, filename);
	}
	if (!tarballUrl) return null;

	const upstreamRes = await fetch(tarballUrl, {
		headers: { Authorization: `token ${env.GITHUB_TOKEN}`, "User-Agent": USER_AGENT },
	});
	if (!upstreamRes.ok || !upstreamRes.body) {
		return new Response("Upstream GitHub Packages tarball fetch failed", { status: 502 });
	}

	const [clientStream, cacheStream] = upstreamRes.body.tee();
	ctx.waitUntil(mirrorTarballToR2(bucket, name, filename, cacheStream));

	const headers = new Headers();
	headers.set("Content-Type", upstreamRes.headers.get("Content-Type") ?? "application/octet-stream");
	const contentLength = upstreamRes.headers.get("Content-Length");
	if (contentLength) headers.set("Content-Length", contentLength);
	headers.set("Cache-Control", "public, max-age=31536000, immutable");

	return new Response(clientStream, { headers });
}
