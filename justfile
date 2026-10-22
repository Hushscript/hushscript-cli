# Every recipe runs in containers; nothing here touches host toolchains.
# Examples: `just ci`, `just test 24`, `CONFORMANCE_CONTEXT=../hushscript-sdk-conformance just e2e`.
set shell := ["bash", "-euo", "pipefail", "-c"]

export HOST_UID := `id -u`
export HOST_GID := `id -g`
# The mock is built from the ref in package.json (`config.conformanceRef`), the one place it is pinned.
conformance_ref := `sed -n 's/^ *"conformanceRef": *"\([^"]*\)".*/\1/p' package.json`
export CONFORMANCE_CONTEXT := env("CONFORMANCE_CONTEXT", "https://github.com/Hushscript/hushscript-sdk-conformance.git#" + conformance_ref)

node24_image := "node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5"
node26_image := "node:26-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913"
hadolint_image := "hadolint/hadolint:v2.15.1@sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d"
actionlint_image := "rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667"
zizmor_image := "ghcr.io/zizmorcore/zizmor:1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9"
gitleaks_image := "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
sandbox := "--rm --init --label sdk.test=1 --cap-drop ALL --read-only --security-opt no-new-privileges --pids-limit 512 --memory 4g --tmpfs /tmp"
floor := "24"
latest := "26"
supported := "24 26"

# unit tests with coverage on Node 24 (default) or 26; no network beyond the mock
test version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock test
    docker compose run --rm test

# build the CLI and run the built binary against the conformance mock
e2e version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock e2e
    docker compose run --rm e2e

# every static check: tsc, eslint, prettier, knip, hadolint, actionlint, zizmor, gitleaks, typos, npm audit
lint version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock lint
    docker compose run --rm lint
    run() { docker run {{sandbox}} --network none --user "$(id -u):$(id -g)" -v "$(pwd)":/work:ro -w /work -e HOME=/tmp "$@"; }
    run {{hadolint_image}} /bin/hadolint docker/dev.Dockerfile docker/typos.Dockerfile
    run {{actionlint_image}} -color
    run {{zizmor_image}} --pedantic --offline --config zizmor.yml .github
    run {{gitleaks_image}} git --no-banner --redact --verbose /work
    docker build --quiet -f docker/typos.Dockerfile -t hushscript-cli-typos:local docker
    run hushscript-cli-typos:local --config _typos.toml
    # The one lint step with network access: it asks the registry about advisories and signatures.
    # Advisories are checked on the newest Node only.
    audit=""
    if [ "{{version}}" = "{{latest}}" ]; then audit='timeout 300 npm audit --omit=dev --audit-level=high && '; fi
    docker run {{sandbox}} "hushscript-cli-dev:node{{version}}" \
      sh -c "${audit}"'timeout 300 npm audit signatures'

# package build plus package-correctness checks, then install the packed CLI next to its production dependencies and run it.
# tsup bundles its config next to the file, so the (read-only) repo root gets a copy in /tmp.
build version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    export NODE_VERSION={{version}}
    node_image={{ if version == "24" { node24_image } else { node26_image } }}
    docker build --quiet --target dev --build-arg NODE_VERSION={{version}} -f docker/dev.Dockerfile -t "hushscript-cli-dev:node{{version}}" .
    docker build --quiet --target proddeps --build-arg NODE_VERSION={{version}} -f docker/dev.Dockerfile -t "hushscript-cli-proddeps:node{{version}}" .
    out="$(mktemp -d)"
    trap 'rm -rf "$out"' EXIT
    mkdir -p "$out/dist" "$out/consumer/node_modules/@hushscript/cli" "$out/consumer/node_modules/.bin"
    user="$(id -u):$(id -g)"
    docker run {{sandbox}} --network none --user "$user" -e HOME=/tmp -e npm_config_cache=/tmp/npm \
      -v "$out/dist":/work/dist -v "$out":/out "hushscript-cli-dev:node{{version}}" \
      sh -c 'cp tsup.config.ts /tmp/tsup.config.ts && timeout 600 tsup --config /tmp/tsup.config.ts \
        && timeout 120 npm pack --dry-run --ignore-scripts \
        && timeout 120 npm pack --ignore-scripts --json --pack-destination /out > /out/pack.json \
        && timeout 60 node scripts/check-publish-files.mjs /out/pack.json \
        && timeout 120 publint /out/hushscript-cli-*.tgz \
        && tar -xzf /out/hushscript-cli-*.tgz -C /out/consumer/node_modules/@hushscript/cli --strip-components=1'
    docker run {{sandbox}} --network none --user "$user" -v "$out":/out "hushscript-cli-proddeps:node{{version}}" \
      sh -c 'cp -r /work/node_modules/. /out/consumer/node_modules/ && printf "{\"type\":\"module\",\"dependencies\":{\"@hushscript/cli\":\"*\"}}\n" > /out/consumer/package.json'
    ln -s ../@hushscript/cli/dist/index.js "$out/consumer/node_modules/.bin/hushscript"
    # The installed binary starts through its shebang in clean Node and reports the packed version.
    version_json="$(jq -r .version package.json)"
    docker run {{sandbox}} --network none --user "$user" -v "$out/consumer":/consumer:ro -w /consumer "$node_image" \
      sh -c "test \"\$(timeout 60 node_modules/.bin/hushscript --version)\" = '$version_json' && timeout 60 node_modules/.bin/hushscript --help | grep -q transcribe && echo 'cli ok'"

# what `npm publish` would upload, without uploading: the file list must be dist/index.js, README, LICENSE and package.json only.
# Same sandbox as `build` (no network); the registry is never contacted.
publish-dry-run version=floor:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "24" { "" } else if version == "26" { "" } else { error("version must be 24 or 26") } }}
    docker build --quiet --target dev --build-arg NODE_VERSION={{version}} -f docker/dev.Dockerfile -t "hushscript-cli-dev:node{{version}}" .
    out="$(mktemp -d)"
    trap 'rm -rf "$out"' EXIT
    mkdir -p "$out/dist"
    docker run {{sandbox}} --network none --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/npm \
      -v "$out/dist":/work/dist "hushscript-cli-dev:node{{version}}" \
      sh -c 'cp tsup.config.ts /tmp/tsup.config.ts && timeout 600 tsup --config /tmp/tsup.config.ts \
        && timeout 120 npm publish --dry-run --provenance=false --ignore-scripts \
        && timeout 120 npm pack --dry-run --ignore-scripts --json > /tmp/pack.json \
        && timeout 60 node scripts/check-publish-files.mjs /tmp/pack.json'

# lint, then test and e2e, then build; no argument runs Node 24 and 26
ci version="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{version}}" ]; then versions="{{version}}"; else versions="{{supported}}"; fi
    for v in $versions; do
      just lint "$v"
      just test "$v"
      just e2e "$v"
      just build "$v"
    done
