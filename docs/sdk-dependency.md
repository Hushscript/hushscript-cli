# The `@hushscript/sdk` dependency before its first publish

`package.json` declares `"@hushscript/sdk": "^0.1.0"`, the way it will stay. Until 0.1.0 is on npm
(ruling R64) nothing can install that from the registry, so the local gate installs a tarball packed
from the TypeScript SDK repository.

- `sdk-ref` holds the commit of `hushscript-sdk-typescript` the CLI is built against.
- `scripts/sdk-pack.sh` (the `just sdk-pack` recipe, a dependency of every other recipe) archives
  that commit with `git archive`, builds and packs it in a container and writes
  `.sdk/hushscript-sdk.tgz` (ignored by git). It skips the work when `.sdk/ref` already names the
  commit. `SDK_DIR` points at the checkout (default `../hushscript-sdk-typescript`). `ci.yml` checks the
  SDK out at that commit and sets `SDK_DIR`.
- `package-lock.json` records `node_modules/@hushscript/sdk` as `resolved: "file:.sdk/hushscript-sdk.tgz"`
  with no integrity. The SDK's own dependencies (`openapi-fetch`, `music-metadata`) are locked from the
  registry as usual, so `npm audit` and Dependabot see them.
- The CLI imports only the SDK's public exports.

## Moving to the published SDK

Once `@hushscript/sdk@0.1.0` is on npm:

1. `npm install --package-lock-only --ignore-scripts @hushscript/sdk@0.1.0` (in a container with
   network, as in the template's lockfile bootstrap) rewrites the lock entry to the registry tarball.
2. Delete `sdk-ref`, `scripts/sdk-pack.sh`, the `sdk-pack` recipe and its uses in the `justfile`,
   the `COPY .sdk/...` lines in `docker/dev.Dockerfile`, the SDK checkout step in `ci.yml`, and the
   `.sdk/` entries in `.gitignore`, `.prettierignore`, `_typos.toml` and `eslint.config.js`.

Until then `publish.yml` cannot run `npm ci` (the lockfile points at a tarball that exists only in the
local gate), which is intended: the CLI is not published before the SDK.

## Upgrading the pinned commit

Put the new commit in `sdk-ref`, run `just sdk-pack` (it repacks), then `just ci`. If the SDK's
dependencies changed, regenerate the lock entry for them with the lockfile bootstrap from
`docs/repo-template.md` in the TypeScript repository, pointing the dependency at
`file:.sdk/hushscript-sdk.tgz`, and restore `^0.1.0` and the missing integrity by hand.
