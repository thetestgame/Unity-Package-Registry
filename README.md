# Unity Package Registry

A Unity package manager compatible NPM registry hosted on Cloudflare Workers.

## How it works

- Package metadata ("packuments") are stored as JSON at `metadata/{name}.json` in R2.
- Tarballs are stored at `tarballs/{name}/{filename}` in R2.
- `dist.tarball` URLs in published metadata are rewritten to point back at this
  Worker, so downloads always flow through it regardless of what host the
  client published from.
- Write operations (`publish`, `unpublish`, `dist-tags` writes) always require a
  bearer token. Reads are open by default; set `REQUIRE_AUTH_FOR_READ=true` in
  `wrangler.jsonc` to lock down reads too (needed if the bucket holds private
  packages).

## Setup

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars   # edit AUTH_TOKENS (and GITHUB_TOKEN if proxying) for local dev
npx wrangler r2 bucket create npm-registry
npx wrangler secret put AUTH_TOKENS      # comma-separated tokens, production
npx wrangler deploy
```

Run locally with `npm run dev` (uses `.dev.vars` for secrets).

## GitHub Packages proxy

GitHub's npm registry (`npm.pkg.github.com`) always requires authentication
(even for public packages) and serves tarballs via a redirect that some
clients — including Unity's Package Manager — don't handle reliably. This
worker can transparently mirror one or more GitHub owners/orgs so clients
only ever talk to your own registry:

1. Set `GITHUB_PROXY_SCOPES` in `wrangler.jsonc` to the npm scopes (which
   must match the GitHub owner/org login) you want proxied, e.g.
   `"@myorg,@myuser"`.
2. Set a `GITHUB_TOKEN` secret with `read:packages` scope (add `repo` too if
   any proxied packages are private):
   ```powershell
   npx wrangler secret put GITHUB_TOKEN
   ```

Behavior:
- A locally-published package (via `PUT /{package}`) always takes priority
  over the GitHub mirror for the same name.
- `GET /{package}` for an unpublished package under a proxied scope fetches
  the packument from `npm.pkg.github.com` (cached in R2 for
  `GITHUB_MIRROR_TTL_SECONDS`, default 300s), rewriting every version's
  `dist.tarball` to point back at this worker.
- `GET /{package}/-/{filename}` streams the tarball from GitHub using the
  worker's own token — the client never sees a GitHub credential — and
  lazily mirrors the bytes into R2 so later requests for that version are
  served locally without hitting GitHub again.
- Packages/scopes not covered by `GITHUB_PROXY_SCOPES` are unaffected.

## Package discovery (`/-/all` and `/-/v1/search`)

Unity's scoped registries need a discovery endpoint to browse
"every available package" instead of requiring the exact name up front.

This worker implements both:

- **`GET /-/v1/search?text=&size=&from=`** — the modern npm search API.
- **`GET /-/all`** — the legacy "list every package" endpoint some older
  clients (and Unity's fallback path) still use.

Both combine:
1. Every locally-published package (enumerated directly from R2, no extra
   index needed).
2. Every package under a `GITHUB_PROXY_SCOPES` owner, enumerated via the
   GitHub REST API (`GET /orgs|users/{owner}/packages?package_type=npm`) —
   not just packages that happen to already be mirrored — so the full
   catalog is browsable even before anyone has fetched a given package.
   Results are cached in R2 per scope for `GITHUB_INDEX_TTL_SECONDS`
   (default 600s).

If GitHub package listing fails (bad token, rate limit, etc.) it's logged
and skipped; local packages still show up normally.

## Supported routes

| Method | Path                                             | Purpose                                  |
|--------|--------------------------------------------------|------------------------------------------|
| GET    | `/`                                              | Health/info                              |
| GET    | `/{package}`                                     | Fetch packument                          |
| GET    | `/{package}/{version}`                           | Fetch a single version manifest          |
| GET    | `/{package}/-/{filename}`                        | Download tarball                         |
| PUT    | `/{package}`                                     | Publish (npm publish payload)            |
| DELETE | `/{package}`                                     | Unpublish whole package                  |
| DELETE | `/{package}/-rev/{rev}`                          | Unpublish whole package (legacy)         |
| DELETE | `/{package}/{version}/-rev/{rev}`                | Unpublish one version                    |
| GET    | `/-/whoami`                                      | Verify a bearer token                    |
| PUT    | `/-/user/org.couchdb.user:{name}`                | `npm login`/`adduser` compatibility stub |
| GET/PUT/DELETE | `/-/package/{package}/dist-tags[/{tag}]` | Read/write dist-tags                     |
| GET    | `/-/v1/search?text=&size=&from=`                 | Search/browse all known packages         |
| GET    | `/-/all`                                         | Legacy "list every package" endpoint     |

## Using with npm

`.npmrc`:
```
registry=https://your-worker.example.workers.dev/
//your-worker.example.workers.dev/:_authToken=<token>
always-auth=true
```

Then `npm publish` / `npm install` work normally.

## Using with Unity Package Manager

Add a scoped registry to your Unity project's `manifest.json`:

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
    "com.myorg.mypackage": "1.0.0"
  }
}
```

If the registry requires auth, add a token in `%USERPROFILE%\.upmconfig.toml`
(or `~/.upmconfig.toml`):

```toml
[npmAuth."https://your-worker.example.workers.dev"]
token = "<token>"
alwaysAuth = true
```

Publish packages for Unity with standard `npm publish` from the package
directory (a `package.json` with `name`, `version`, and Unity's
`com.<company>.<name>` naming convention).
