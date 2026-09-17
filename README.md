# Unity Package Registry

> A lightweight, npm-compatible package registry for Unity packages, running entirely on Cloudflare Workers and R2.

Publish and install Unity packages with the tools you already use. Keep package metadata and tarballs in your own Cloudflare account, optionally proxy private or public packages from GitHub Packages, and expose a registry endpoint that works with both npm and Unity Package Manager.

## Why this exists

GitHub Packages is a useful source for npm packages, but Unity Package Manager can be awkward to use with it directly: Github does not support the full set of NPM endpoints, authentication is mandatory and tarball redirects are not handled reliably by every client. This Worker provides a stable registry URL in front of Cloudflare R2 and GitHub Packages.

## Highlights

- **npm-compatible publishing** with `npm publish`, unpublish, and dist-tags.
- **Unity Package Manager support** for scoped registries and package discovery.
- **Cloudflare-native storage** using R2 for metadata, tarballs, and mirror caches.
- **Optional GitHub Packages proxy** that keeps GitHub credentials server-side.
- **Lazy mirroring** of GitHub tarballs so repeat downloads can stay in R2.
- **Open or private reads** with configurable bearer-token authentication.
- **No database or separate package index** required for locally published packages.

## Architecture

```text
npm / Unity Package Manager
             |
             v
     Cloudflare Worker
       |           |
       v           v
   Cloudflare R2   GitHub Packages
   metadata       optional upstream
   tarballs       mirror and proxy
```

Local package data is stored using predictable R2 keys:

| Data | R2 key |
| --- | --- |
| Package metadata (packument) | `metadata/{name}.json` |
| Package tarball | `tarballs/{name}/{filename}` |
| GitHub packument cache | `github-mirror/{name}.json` |
| GitHub discovery cache | `github-index/{scope}.json` |

Published metadata has its `dist.tarball` URLs rewritten to point at the Worker, so clients always download through the registry.

## Quick start

### Prerequisites

- Node.js 18 or newer
- A Cloudflare account with Workers and R2 enabled
- Wrangler authentication (`npx wrangler login`)

### Install and configure

```powershell
npm install
npx wrangler login
npx wrangler r2 bucket create unity-package-registry
```

Create a local `.dev.vars` file for development. It is intentionally not committed:

```dotenv
AUTH_TOKENS=replace-with-a-long-random-token
# Optional GitHub Packages proxy
# GITHUB_TOKEN=github-token-with-read-packages
```

Run the Worker locally:

```powershell
npm run dev
```

The default `wrangler.jsonc` already points the `REGISTRY_BUCKET` binding at `unity-package-registry`. Change the bucket name there if you created a different bucket.

### Deploy

Set the production write token as a Worker secret and deploy:

```powershell
npx wrangler secret put AUTH_TOKENS
npm run deploy
```

`AUTH_TOKENS` accepts one or more comma-separated bearer tokens. Use long, randomly generated values and rotate them when needed.

## Configuration

Edit the `vars` section in [`wrangler.jsonc`](wrangler.jsonc) for non-secret settings. Store credentials with `wrangler secret put` or in `.dev.vars` for local development.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AUTH_TOKENS` | Writes | None | Comma-separated bearer tokens for publish, unpublish, and dist-tag writes. |
| `REQUIRE_AUTH_FOR_READ` | No | `false` | Set to `true` to require bearer auth for package reads, searches, and tarballs. |
| `GITHUB_PROXY_SCOPES` | No | Empty | Comma-separated npm scopes such as `@myorg,@myuser` to proxy from GitHub Packages. |
| `GITHUB_TOKEN` | With proxy | None | GitHub token with `read:packages`; add `repo` when private packages require it. |
| `GITHUB_MIRROR_TTL_SECONDS` | No | `300` | Freshness window for cached GitHub packuments. |
| `GITHUB_INDEX_TTL_SECONDS` | No | `600` | Freshness window for GitHub package-name discovery results. |

### Enable the GitHub Packages proxy

1. Set `GITHUB_PROXY_SCOPES` to GitHub owner names with the npm scope format. The scope must match the GitHub organization or user login.
2. Add the GitHub token as a secret:

   ```powershell
   npx wrangler secret put GITHUB_TOKEN
   ```

3. Deploy again with `npm run deploy`.

Local packages take priority over the GitHub mirror when both use the same package name. Packages outside the configured scopes are unaffected.

When a proxied package is requested, the Worker fetches and caches its packument, rewrites tarball URLs to the Worker, and streams GitHub tarballs using its own token. The client never receives the GitHub credential. Successful tarball downloads are lazily copied to R2.

## Configure clients

### npm

Add a project or user `.npmrc`:

```ini
registry=https://your-worker.example.workers.dev/
//your-worker.example.workers.dev/:_authToken=your-registry-token
always-auth=true
```

Then use standard commands:

```powershell
npm publish
npm install @myorg/my-package
npm dist-tag add @myorg/my-package 1.0.0 latest
```

### Unity Package Manager

Add a scoped registry to the Unity project's `Packages/manifest.json`:

```json
{
  "scopedRegistries": [
    {
      "name": "My Registry",
      "url": "https://your-worker.example.workers.dev",
      "scopes": ["com.myorg"]
    }
  ],
  "dependencies": {
    "com.myorg.my-package": "1.0.0"
  }
}
```

For a private registry, add the token to `%USERPROFILE%\.upmconfig.toml` on Windows or `~/.upmconfig.toml` on macOS/Linux:

```toml
[npmAuth."https://your-worker.example.workers.dev"]
token = "your-registry-token"
alwaysAuth = true
```

Unity packages should use a `package.json` with `name`, `version`, and Unity's conventional `com.<company>.<name>` package naming format.

## Package discovery

The Worker implements both npm discovery APIs used by modern and older clients:

- `GET /-/v1/search?text=&size=&from=` for npm-style search.
- `GET /-/all` for the legacy full-catalog response used by some clients and Unity fallback paths.

Discovery combines locally published packages with packages found under configured GitHub proxy scopes. Local names are enumerated directly from R2. GitHub package listings are fetched through the GitHub REST API and cached per scope, so packages are discoverable before their first download.

If GitHub discovery is unavailable because of a token, rate limit, or upstream error, local packages continue to appear normally.

## API routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Health and registry information |
| `GET`, `HEAD` | `/{package}` | Fetch a package packument |
| `GET`, `HEAD` | `/{package}/{version}` | Fetch a version manifest or dist-tag target |
| `GET`, `HEAD` | `/{package}/-/{filename}` | Download a tarball |
| `PUT` | `/{package}` | Publish an npm publish payload |
| `DELETE` | `/{package}` | Unpublish an entire package |
| `DELETE` | `/{package}/-rev/{rev}` | Legacy whole-package unpublish |
| `DELETE` | `/{package}/{version}` | Unpublish one version |
| `DELETE` | `/{package}/{version}/-rev/{rev}` | Legacy single-version unpublish |
| `GET` | `/-/whoami` | Verify a bearer token |
| `PUT` | `/-/user/org.couchdb.user:{name}` | npm login/adduser compatibility stub |
| `GET`, `PUT`, `DELETE` | `/-/package/{package}/dist-tags[/{tag}]` | Read or write dist-tags |
| `GET` | `/-/v1/search?text=&size=&from=` | Search known packages |
| `GET` | `/-/all` | Return the legacy full package catalog |

All write operations require a valid bearer token. Reads are public by default and become protected when `REQUIRE_AUTH_FOR_READ=true`.

## Development

Useful commands:

```powershell
npm run dev       # Start the local Wrangler development server
npm run typecheck # Check TypeScript without emitting files
npm run types     # Regenerate Wrangler runtime types
npm run deploy    # Deploy the Worker
```

The implementation lives in `src/`:

- `index.ts` handles routing and request/response behavior.
- `store.ts` manages R2 metadata and tarballs.
- `publish.ts` handles npm publish and unpublish payloads.
- `auth.ts` handles bearer-token authentication.
- `github.ts` handles GitHub Packages mirroring and tarball proxying.
- `discovery.ts` handles local and GitHub package discovery.

## Security notes

- Never commit `.dev.vars`, GitHub tokens, or registry tokens.
- Keep `GITHUB_TOKEN` in a Worker secret, not in `wrangler.jsonc`.
- Enable `REQUIRE_AUTH_FOR_READ=true` when the registry contains private packages.
- Treat anyone with an `AUTH_TOKENS` value as able to publish and delete packages.
- Restrict GitHub token permissions to the minimum required by the packages you proxy.

## Contributing

Issues and pull requests are welcome. Before opening a change, run `npm run typecheck` and describe any Cloudflare-specific setup needed to reproduce it.

## License

This project is distributed under the MIT License.
