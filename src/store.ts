/** R2-backed storage layout and helpers for packuments (package metadata) and tarballs. */

export interface PackageVersion {
	name: string;
	version: string;
	dist: {
		tarball: string;
		shasum: string;
		integrity?: string;
	};
	[key: string]: unknown;
}

export interface Packument {
	_id: string;
	_rev: string;
	name: string;
	description?: string;
	"dist-tags": Record<string, string>;
	versions: Record<string, PackageVersion>;
	time: Record<string, string>;
	readme?: string;
	[key: string]: unknown;
}

function metadataKey(name: string): string {
	return `metadata/${name}.json`;
}

function tarballKey(name: string, filename: string): string {
	return `tarballs/${name}/${filename}`;
}

function tarballPrefix(name: string): string {
	return `tarballs/${name}/`;
}

export async function getPackument(bucket: R2Bucket, name: string): Promise<Packument | null> {
	const obj = await bucket.get(metadataKey(name));
	if (!obj) return null;
	return obj.json<Packument>();
}

export async function putPackument(bucket: R2Bucket, packument: Packument): Promise<void> {
	await bucket.put(metadataKey(packument.name), JSON.stringify(packument), {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
	});
}

export async function deletePackument(bucket: R2Bucket, name: string): Promise<void> {
	await bucket.delete(metadataKey(name));
}

export async function getTarball(bucket: R2Bucket, name: string, filename: string): Promise<R2ObjectBody | null> {
	return bucket.get(tarballKey(name, filename));
}

export async function putTarball(
	bucket: R2Bucket,
	name: string,
	filename: string,
	data: Uint8Array,
	sha1Hex: string,
): Promise<void> {
	await bucket.put(tarballKey(name, filename), data, {
		httpMetadata: { contentType: "application/octet-stream" },
		sha1: sha1Hex,
	});
}

export async function deleteAllTarballs(bucket: R2Bucket, name: string): Promise<void> {
	let cursor: string | undefined;
	do {
		const listing = await bucket.list({ prefix: tarballPrefix(name), cursor });
		if (listing.objects.length > 0) {
			await bucket.delete(listing.objects.map((o) => o.key));
		}
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
}

export async function deleteTarball(bucket: R2Bucket, name: string, filename: string): Promise<void> {
	await bucket.delete(tarballKey(name, filename));
}
