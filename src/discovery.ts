import { getGithubMirrorPackument, isGithubProxiedScope, isGithubProxyConfigured } from "./github";
import { getPackument } from "./store";

const GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_INDEX_TTL_SECONDS = 600;
const USER_AGENT = "cloudflare-npm-registry-github-proxy";

interface GithubIndexCache {
	cachedAt: string;
	/** npm-style names, e.g. "@owner/pkg" */
	names: string[];
}

function proxyScopes(env: Env): string[] {
	return (env.GITHUB_PROXY_SCOPES ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function indexKey(scope: string): string {
	return `github-index/${scope}.json`;
}

function ttlSeconds(env: Env): number {
	const raw = env.GITHUB_INDEX_TTL_SECONDS as string | undefined;
	const parsed = raw ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_INDEX_TTL_SECONDS;
}

function isFresh(cache: GithubIndexCache, env: Env): boolean {
	const ageMs = Date.now() - Date.parse(cache.cachedAt);
	return Number.isFinite(ageMs) && ageMs < ttlSeconds(env) * 1000;
}

async function readIndexCache(bucket: R2Bucket, scope: string): Promise<GithubIndexCache | null> {
	const obj = await bucket.get(indexKey(scope));
	if (!obj) return null;
	return obj.json<GithubIndexCache>();
}

async function writeIndexCache(bucket: R2Bucket, scope: string, names: string[]): Promise<void> {
	const entry: GithubIndexCache = { cachedAt: new Date().toISOString(), names };
	await bucket.put(indexKey(scope), JSON.stringify(entry), {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
	});
}

function parseNextLink(header: string | null): string | null {
	if (!header) return null;
	for (const part of header.split(",")) {
		const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
		if (match?.[1]) return match[1];
	}
	return null;
}

/**
 * Enumerates every npm package a GitHub owner (org or user) has published,
 * via the GitHub REST API — not just packages this worker happens to have
 * already mirrored. This is what lets Unity/npm browse a full catalog
 * instead of requiring each package name to be known up front.
 */
async function fetchGithubPackageNames(scope: string, env: Env): Promise<string[]> {
	const owner = scope.replace(/^@/, "");
	const names: string[] = [];

	for (const kind of ["orgs", "users"] as const) {
		let url: string | null = `${GITHUB_API_BASE}/${kind}/${encodeURIComponent(owner)}/packages?package_type=npm&per_page=100`;
		let sawAnyResponse = false;

		while (url) {
			const res: Response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${env.GITHUB_TOKEN}`,
					Accept: "application/vnd.github+json",
					"User-Agent": USER_AGENT,
				},
			});
			if (res.status === 404) break; // wrong owner kind; try the other one
			if (!res.ok) {
				throw new Error(`GitHub package listing failed for ${kind}/${owner}: ${res.status} ${res.statusText}`);
			}
			sawAnyResponse = true;
			const body = (await res.json()) as Array<{ name: string }>;
			for (const pkg of body) names.push(`@${owner}/${pkg.name}`);
			url = parseNextLink(res.headers.get("Link"));
		}

		if (sawAnyResponse) break;
	}

	return names;
}

/** Package names known to exist under all configured GitHub-proxied scopes (cached in R2). */
export async function listGithubProxiedPackageNames(bucket: R2Bucket, env: Env): Promise<string[]> {
	const allNames: string[] = [];
	for (const scope of proxyScopes(env)) {
		const cached = await readIndexCache(bucket, scope);
		if (cached && isFresh(cached, env)) {
			allNames.push(...cached.names);
			continue;
		}
		try {
			const names = await fetchGithubPackageNames(scope, env);
			await writeIndexCache(bucket, scope, names);
			allNames.push(...names);
		} catch (err) {
			console.error(`Failed to list GitHub Packages for scope ${scope}`, err);
			if (cached) allNames.push(...cached.names);
		}
	}
	return allNames;
}

/** All locally-published package names, discovered from R2 (no separate index needed). */
export async function listLocalPackageNames(bucket: R2Bucket): Promise<string[]> {
	const prefix = "metadata/";
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const listing = await bucket.list({ prefix, cursor });
		for (const obj of listing.objects) {
			if (obj.key.endsWith(".json")) {
				names.push(obj.key.slice(prefix.length, -".json".length));
			}
		}
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
	return names;
}

/** Resolves a package name to its client-facing packument, local publish taking priority over the GitHub mirror. */
async function resolvePackument(
	bucket: R2Bucket,
	name: string,
	origin: string,
	env: Env,
): Promise<Record<string, unknown> | null> {
	const local = await getPackument(bucket, name);
	if (local) return local as unknown as Record<string, unknown>;

	if (isGithubProxyConfigured(env) && isGithubProxiedScope(name, env)) {
		try {
			return await getGithubMirrorPackument(bucket, name, origin, env);
		} catch (err) {
			console.error(`Failed to resolve GitHub mirror packument for "${name}"`, err);
			return null;
		}
	}
	return null;
}

async function listAllKnownPackuments(bucket: R2Bucket, origin: string, env: Env): Promise<Record<string, unknown>[]> {
	const localNames = await listLocalPackageNames(bucket);
	const githubNames = isGithubProxyConfigured(env) ? await listGithubProxiedPackageNames(bucket, env) : [];
	const uniqueNames = [...new Set([...localNames, ...githubNames])];

	const resolved = await Promise.all(uniqueNames.map((name) => resolvePackument(bucket, name, origin, env)));
	return resolved.filter((p): p is Record<string, unknown> => Boolean(p));
}

/** Builds the legacy `/-/all` response: full packuments keyed by name, plus `_updated`. */
export async function buildAllPackagesResponse(bucket: R2Bucket, origin: string, env: Env): Promise<Record<string, unknown>> {
	const packuments = await listAllKnownPackuments(bucket, origin, env);
	const result: Record<string, unknown> = { _updated: Date.now() };
	for (const p of packuments) {
		const name = p.name as string | undefined;
		if (name) result[name] = p;
	}
	return result;
}

interface SearchOptions {
	text: string;
	size: number;
	from: number;
}

function toSearchObject(p: Record<string, unknown>): Record<string, unknown> {
	const distTags = (p["dist-tags"] as Record<string, string> | undefined) ?? {};
	const versions = (p.versions as Record<string, Record<string, unknown>> | undefined) ?? {};
	const latestVersion = distTags.latest;
	const latestManifest = latestVersion ? versions[latestVersion] : undefined;
	const time = (p.time as Record<string, string> | undefined) ?? {};
	const name = String(p.name ?? "");
	const scopeMatch = /^@([^/]+)\//.exec(name);

	return {
		package: {
			name,
			scope: scopeMatch?.[1] ?? "unscoped",
			version: latestVersion ?? Object.keys(versions)[0] ?? "0.0.0",
			description: p.description ?? latestManifest?.description ?? "",
			keywords: p.keywords ?? latestManifest?.keywords ?? [],
			date: time.modified ?? time.created ?? new Date(0).toISOString(),
			links: {},
			publisher: { username: "registry-user" },
			maintainers: [],
		},
		score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
		searchScore: 1,
	};
}

/** Implements the npm `/-/v1/search` protocol against everything this worker knows about. */
export async function searchPackages(
	bucket: R2Bucket,
	origin: string,
	env: Env,
	options: SearchOptions,
): Promise<{ objects: Record<string, unknown>[]; total: number; time: string }> {
	const packuments = await listAllKnownPackuments(bucket, origin, env);
	const text = options.text.trim().toLowerCase();

	const matches = text
		? packuments.filter((p) => {
				const name = String(p.name ?? "").toLowerCase();
				const description = String(p.description ?? "").toLowerCase();
				const keywords = Array.isArray(p.keywords) ? p.keywords.join(" ").toLowerCase() : "";
				return name.includes(text) || description.includes(text) || keywords.includes(text);
			})
		: packuments;

	const page = matches.slice(options.from, options.from + options.size);
	return {
		objects: page.map(toSearchObject),
		total: matches.length,
		time: new Date().toISOString(),
	};
}
