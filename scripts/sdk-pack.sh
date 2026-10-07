#!/usr/bin/env bash
# Builds the pinned @hushscript/sdk (the commit in ./sdk-ref) and packs it into .sdk/hushscript-sdk.tgz.
# Until the SDK is on npm (ruling R64) the local gate installs this tarball instead of the registry copy.
# Host side: git, tar and docker only. The build runs in a container with the sandbox flags of the justfile
# (network allowed, because `npm ci` fetches the SDK's own locked dependencies).
#
#   scripts/sdk-pack.sh <sdk-repo-dir> <node-image>
set -euo pipefail

sdk_dir="${1:?usage: sdk-pack.sh <sdk-repo-dir> <node-image>}"
image="${2:?usage: sdk-pack.sh <sdk-repo-dir> <node-image>}"
cd "$(dirname "$0")/.."

ref="$(tr -d '[:space:]' < sdk-ref)"
if [ -f .sdk/ref ] && [ -f .sdk/hushscript-sdk.tgz ] && [ "$(cat .sdk/ref)" = "$ref" ]; then
  echo "sdk-pack: .sdk/hushscript-sdk.tgz is up to date for $ref"
  exit 0
fi
if ! git -C "$sdk_dir" cat-file -e "$ref^{commit}" 2>/dev/null; then
  echo "sdk-pack: commit $ref is not in $sdk_dir (set SDK_DIR to a checkout of hushscript-typescript)" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/src" "$work/out"
git -C "$sdk_dir" archive "$ref" | tar -x -C "$work/src"

docker run --rm --init --label sdk.test=1 --cap-drop ALL --read-only --security-opt no-new-privileges \
  --pids-limit 512 --memory 4g --tmpfs /tmp --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$work/src":/work -v "$work/out":/out -w /work "$image" \
  sh -c 'timeout 600 npm ci --ignore-scripts --no-audit --no-fund \
    && cp tsup.config.ts /tmp/tsup.config.ts \
    && timeout 600 node_modules/.bin/tsup --config /tmp/tsup.config.ts \
    && timeout 120 npm pack --ignore-scripts --pack-destination /out'

mkdir -p .sdk
cp "$work"/out/hushscript-sdk-*.tgz .sdk/hushscript-sdk.tgz
echo "$ref" > .sdk/ref
echo "sdk-pack: packed $ref into .sdk/hushscript-sdk.tgz"
