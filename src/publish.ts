import {
	deleteAllTarballs,
	deletePackument,
	deleteTarball,
	getPackument,
	putPackument,
	putTarball,
	type Packument,
	type PackageVersion,
} from "./store";
import { badRequest, base64ToBytes, encodePackageName, json, sha1Hex } from "./utils";

interface PublishAttachment {
	content_type?: string;
	data: string;
	length?: number;
}

interface PublishPayload {
	_id?: string;
	name: string;
	description?: string;
	"dist-tags"?: Record<string, string>;
	versions: Record<string, PackageVersion>;
	_attachments?: Record<string, PublishAttachment>;
	readme?: string;
}

/**
 * Handles `npm publish` style `PUT /:package` requests: a single JSON body
 * containing the new version's manifest plus a base64-encoded tarball in
 * `_attachments`. Merges the result into any existing packument.
 */
export async function handlePublish(
	request: Request,
	bucket: R2Bucket,
	urlPackageName: string,
	origin: string,
): Promise<Response> {
	let payload: PublishPayload;
	try {
		payload = await request.json();
	} catch {
		return badRequest("Request body must be valid JSON");
	}

	if (!payload || typeof payload.name !== "string" || !payload.versions) {
		return badRequest("Publish payload missing required 'name'/'versions' fields");
	}
	if (payload.name !== urlPackageName) {
		return badRequest(`Package name in body ("${payload.name}") does not match URL ("${urlPackageName}")`);
	}

	const existing = await getPackument(bucket, payload.name);
	const now = new Date().toISOString();

	const packument: Packument = existing ?? {
		_id: payload.name,
		_rev: "0",
		name: payload.name,
		"dist-tags": {},
		versions: {},
		time: { created: now },
	};

	// Store each attachment's tarball bytes in R2, then repoint dist.tarball
	// at this worker so downloads always flow back through us.
	for (const [filename, attachment] of Object.entries(payload._attachments ?? {})) {
		const bytes = base64ToBytes(attachment.data);
		const digest = await sha1Hex(bytes);
		await putTarball(bucket, payload.name, filename, bytes, digest);

		for (const version of Object.values(payload.versions)) {
			if (version?.dist?.tarball && version.dist.tarball.endsWith(`/${filename}`)) {
				version.dist.tarball = `${origin}/${encodePackageName(payload.name)}/-/${filename}`;
				if (!version.dist.shasum) version.dist.shasum = digest;
			}
		}
	}

	for (const [version, manifest] of Object.entries(payload.versions)) {
		packument.versions[version] = manifest;
		packument.time[version] = now;
	}

	packument["dist-tags"] = { ...packument["dist-tags"], ...(payload["dist-tags"] ?? {}) };
	if (payload.description) packument.description = payload.description;
	if (payload.readme) packument.readme = payload.readme;
	packument.time.modified = now;
	packument._rev = String(Number(packument._rev ?? "0") + 1);

	await putPackument(bucket, packument);

	return json({ ok: true, id: packument._id, rev: packument._rev }, { status: 201 });
}

/** Deletes an entire package (all versions, tarballs, and metadata). */
export async function handleUnpublishPackage(bucket: R2Bucket, name: string): Promise<Response> {
	const existing = await getPackument(bucket, name);
	if (!existing) return json({ error: "Not found" }, { status: 404 });
	await deleteAllTarballs(bucket, name);
	await deletePackument(bucket, name);
	return json({ ok: true });
}

/** Removes a single version from a package, cleaning up its tarball and dist-tags. */
export async function handleUnpublishVersion(bucket: R2Bucket, name: string, version: string): Promise<Response> {
	const packument = await getPackument(bucket, name);
	if (!packument || !packument.versions[version]) {
		return json({ error: "Not found" }, { status: 404 });
	}

	const removed = packument.versions[version];
	delete packument.versions[version];
	delete packument.time[version];

	const tarballUrl = removed?.dist?.tarball;
	if (tarballUrl) {
		const filename = tarballUrl.split("/-/").pop();
		if (filename) {
			await deleteTarball(bucket, name, decodeURIComponent(filename));
		}
	}

	for (const [tag, taggedVersion] of Object.entries(packument["dist-tags"])) {
		if (taggedVersion === version) delete packument["dist-tags"][tag];
	}

	const remainingVersions = Object.keys(packument.versions);
	if (remainingVersions.length === 0) {
		return handleUnpublishPackage(bucket, name);
	}

	packument._rev = String(Number(packument._rev ?? "0") + 1);
	packument.time.modified = new Date().toISOString();
	await putPackument(bucket, packument);
	return json({ ok: true });
}
