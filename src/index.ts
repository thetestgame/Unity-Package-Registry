import { requireAuth, requireReadAuth } from "./auth";
import { buildAllPackagesResponse, searchPackages } from "./discovery";
import { getGithubMirrorPackument, isGithubProxiedScope, isGithubProxyConfigured, proxyGithubTarball } from "./github";
import { getPackument, getTarball, putPackument, type Packument } from "./store";
import { handlePublish, handleUnpublishPackage, handleUnpublishVersion } from "./publish";
import { badRequest, json, notFound, splitPath } from "./utils";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			return await route(request, env, ctx);
		} catch (err) {
			console.error("Unhandled error", err);
			return json({ error: "Internal server error" }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const segments = splitPath(url.pathname);
	const bucket = env.REGISTRY_BUCKET;

	if (segments.length === 0) {
		return json({
			name: "unity-package-registry",
			description: "A Unity package manager compatible NPM registry hosted on Cloudflare Workers.",
		});
	}

	// --- Well-known npm control routes, all under /-/... ---
	if (segments[0] === "-") {
		return routeWellKnown(request, env, segments);
	}

	const packageName = segments[0]!;

	// GET/PUT/DELETE /{package}
	if (segments.length === 1) {
		return routePackage(request, env, packageName);
	}

	// GET /{package}/-/{filename}  (tarball download)
	if (segments.length === 3 && segments[1] === "-") {
		return routeTarball(request, env, ctx, packageName, segments[2]!);
	}

	// DELETE /{package}/-rev/{rev}  (legacy whole-package unpublish)
	if (segments.length === 3 && segments[1] === "-rev") {
		if (request.method !== "DELETE") return badRequest("Unsupported method for -rev route");
		const authError = await requireAuth(request, env);
		if (authError) return authError;
		return handleUnpublishPackage(bucket, packageName);
	}

	// GET/DELETE /{package}/{version}
	if (segments.length === 2) {
		return routeVersion(request, env, packageName, segments[1]!);
	}

	// DELETE /{package}/{version}/-rev/{rev}  (single version unpublish)
	if (segments.length === 4 && segments[2] === "-rev") {
		if (request.method !== "DELETE") return badRequest("Unsupported method for -rev route");
		const authError = await requireAuth(request, env);
		if (authError) return authError;
		return handleUnpublishVersion(bucket, packageName, segments[1]!);
	}

	return notFound();
}

async function routePackage(request: Request, env: Env, packageName: string): Promise<Response> {
	const bucket = env.REGISTRY_BUCKET;

	if (request.method === "GET" || request.method === "HEAD") {
		const authError = await requireReadAuth(request, env);
		if (authError) return authError;

		const packument = await getPackument(bucket, packageName);
		if (packument) {
			if (request.method === "HEAD") return new Response(null, { status: 200 });
			return json(packument);
		}

		if (isGithubProxyConfigured(env) && isGithubProxiedScope(packageName, env)) {
			const origin = new URL(request.url).origin;
			let mirrored: Record<string, unknown> | null;
			try {
				mirrored = await getGithubMirrorPackument(bucket, packageName, origin, env);
			} catch {
				return json({ error: "Upstream GitHub Packages request failed" }, { status: 502 });
			}
			if (mirrored) {
				if (request.method === "HEAD") return new Response(null, { status: 200 });
				return json(mirrored);
			}
		}

		return notFound();
	}

	if (request.method === "PUT") {
		const authError = await requireAuth(request, env);
		if (authError) return authError;
		return handlePublish(request, bucket, packageName, new URL(request.url).origin);
	}

	if (request.method === "DELETE") {
		const authError = await requireAuth(request, env);
		if (authError) return authError;
		return handleUnpublishPackage(bucket, packageName);
	}

	return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, HEAD, PUT, DELETE" } });
}

async function routeVersion(request: Request, env: Env, packageName: string, version: string): Promise<Response> {
	const bucket = env.REGISTRY_BUCKET;

	if (request.method === "GET" || request.method === "HEAD") {
		const authError = await requireReadAuth(request, env);
		if (authError) return authError;

		let packument = await getPackument(bucket, packageName);
		if (!packument && isGithubProxyConfigured(env) && isGithubProxiedScope(packageName, env)) {
			const origin = new URL(request.url).origin;
			let mirrored: Record<string, unknown> | null;
			try {
				mirrored = await getGithubMirrorPackument(bucket, packageName, origin, env);
			} catch {
				return json({ error: "Upstream GitHub Packages request failed" }, { status: 502 });
			}
			if (mirrored) packument = mirrored as unknown as Packument;
		}
		if (!packument) return notFound();

		const resolvedVersion = packument["dist-tags"][version] ?? version;
		const manifest = packument.versions[resolvedVersion];
		if (!manifest) return notFound();
		if (request.method === "HEAD") return new Response(null, { status: 200 });
		return json(manifest);
	}

	if (request.method === "DELETE") {
		const authError = await requireAuth(request, env);
		if (authError) return authError;
		return handleUnpublishVersion(bucket, packageName, version);
	}

	return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, HEAD, DELETE" } });
}

async function routeTarball(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	packageName: string,
	filename: string,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, HEAD" } });
	}

	const authError = await requireReadAuth(request, env);
	if (authError) return authError;

	const bucket = env.REGISTRY_BUCKET;
	const object = await getTarball(bucket, packageName, filename);
	if (object) {
		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set("Content-Length", String(object.size));
		headers.set("Cache-Control", "public, max-age=31536000, immutable");
		headers.set("ETag", object.httpEtag);

		if (request.method === "HEAD") return new Response(null, { headers });
		return new Response(object.body, { headers });
	}

	if (isGithubProxyConfigured(env) && isGithubProxiedScope(packageName, env)) {
		let proxied: Response | null;
		try {
			proxied = await proxyGithubTarball(bucket, packageName, filename, env, ctx);
		} catch {
			return json({ error: "Upstream GitHub Packages request failed" }, { status: 502 });
		}
		if (proxied) {
			if (request.method === "HEAD") return new Response(null, { headers: proxied.headers, status: proxied.status });
			return proxied;
		}
	}

	return notFound();
}

async function routeWellKnown(request: Request, env: Env, segments: string[]): Promise<Response> {
	// GET /-/whoami
	if (segments.length === 2 && segments[1] === "whoami" && request.method === "GET") {
		const authError = await requireAuth(request, env);
		if (authError) return authError;
		return json({ username: "registry-user" });
	}

	// PUT /-/user/org.couchdb.user:<name>  (npm login / npm adduser compatibility stub)
	if (segments.length === 3 && segments[1] === "user" && request.method === "PUT") {
		const tokens = (env.AUTH_TOKENS ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		if (tokens.length === 0) {
			return json({ error: "Server has no AUTH_TOKENS configured" }, { status: 503 });
		}
		return json({ ok: true, id: segments[2], rev: "0-0", token: tokens[0] });
	}

	// /-/package/{name}/dist-tags[/{tag}]
	if (segments[1] === "package" && segments[3] === "dist-tags") {
		return routeDistTags(request, env, segments[2]!, segments[4]);
	}

	// GET /-/all  (legacy "list every package" endpoint; older npm/Unity clients need this)
	if (segments.length === 2 && segments[1] === "all" && (request.method === "GET" || request.method === "HEAD")) {
		const authError = await requireReadAuth(request, env);
		if (authError) return authError;
		try {
			const all = await buildAllPackagesResponse(env.REGISTRY_BUCKET, new URL(request.url).origin, env);
			if (request.method === "HEAD") return new Response(null, { status: 200 });
			return json(all);
		} catch {
			return json({ error: "Failed to build package index" }, { status: 502 });
		}
	}

	// GET /-/v1/search?text=&size=&from=  (modern search endpoint used by Unity/npm to browse packages)
	if (segments.length === 3 && segments[1] === "v1" && segments[2] === "search" && request.method === "GET") {
		const authError = await requireReadAuth(request, env);
		if (authError) return authError;
		const url = new URL(request.url);
		const text = url.searchParams.get("text") ?? "";
		const size = clamp(Number(url.searchParams.get("size")) || 20, 1, 250);
		const from = Math.max(Number(url.searchParams.get("from")) || 0, 0);
		try {
			const results = await searchPackages(env.REGISTRY_BUCKET, url.origin, env, { text, size, from });
			return json(results);
		} catch {
			return json({ error: "Failed to search package index" }, { status: 502 });
		}
	}

	return notFound();
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

async function routeDistTags(request: Request, env: Env, packageName: string, tag: string | undefined): Promise<Response> {
	const bucket = env.REGISTRY_BUCKET;

	if (request.method === "GET") {
		const authError = await requireReadAuth(request, env);
		if (authError) return authError;
		const packument = await getPackument(bucket, packageName);
		if (!packument) return notFound();
		if (!tag) return json(packument["dist-tags"]);
		const version = packument["dist-tags"][tag];
		if (!version) return notFound();
		return json(version);
	}

	if (!tag) return badRequest("A dist-tag name is required for write operations");

	const authError = await requireAuth(request, env);
	if (authError) return authError;

	const packument = await getPackument(bucket, packageName);
	if (!packument) return notFound();

	if (request.method === "PUT") {
		let version: string;
		try {
			version = (await request.json()) as string;
		} catch {
			version = (await request.text()).replace(/^"|"$/g, "");
		}
		if (typeof version !== "string" || !packument.versions[version]) {
			return badRequest(`Version "${String(version)}" does not exist for this package`);
		}
		packument["dist-tags"][tag] = version;
		await putPackument(bucket, packument);
		return json({ ok: true });
	}

	if (request.method === "DELETE") {
		delete packument["dist-tags"][tag];
		await putPackument(bucket, packument);
		return json({ ok: true });
	}

	return json({ error: "Method not allowed" }, { status: 405 });
}
