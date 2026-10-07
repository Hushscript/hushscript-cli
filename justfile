# Every recipe runs in containers; nothing here touches host toolchains.
# Examples: `just ci`, `just test 24`, `CONFORMANCE_CONTEXT=../hushscript-sdk-conformance just e2e`.
set shell := ["bash", "-euo", "pipefail", "-c"]

export HOST_UID := `id -u`
export HOST_GID := `id -g`
# The mock is built from the ref in package.json (`config.conformanceRef`), the one place it is pinned.
conformance_ref := `sed -n 's/^ *"conformanceRef": *"\([^"]*\)".*/\1/p' package.json`
export CONFORMANCE_CONTEXT := env("CONFORMANCE_CONTEXT", "https://github.com/Hushscript/hushscript-sdk-conformance.git#" + conformance_ref)
# Until @hushscript/sdk is on npm (ruling R64) the gate packs it from this checkout at the commit in ./sdk-ref.
sdk_dir := env("SDK_DIR", "../hushscript-typescript")

node22_image := "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392"
node24_image := "node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
hadolint_image := "hadolint/hadolint:v2.14.0@sha256:27086352fd5e1907ea2b934eb1023f217c5ae087992eb59fde121dce9c9ff21e"
actionlint_image := "rhysd/actionlint:1.7.8@sha256:96d4a8c87dbbfb3bdd324f8fdc285fc3df5261e2decc619a4dd7e8ee52bbfd46"
zizmor_image := "ghcr.io/zizmorcore/zizmor:1.16.0@sha256:a6460f1b6fe3dc08e588d314e73563bdd218ee30c995a4be5e9ee5bd300391ce"
shellcheck_image := "koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d"
gitleaks_image := "ghcr.io/gitleaks/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854"
sandbox := "--rm --init --label sdk.test=1 --cap-drop ALL --read-only --security-opt no-new-privileges --pids-limit 512 --memory 4g --tmpfs /tmp"
floor := "22"
latest := "24"

# build the pinned @hushscript/sdk into .sdk/hushscript-sdk.tgz (skipped when it is current)
sdk-pack:
    scripts/sdk-pack.sh "{{sdk_dir}}" "{{node22_image}}"

# unit tests with coverage on Node 22 (default) or 24; no network beyond the mock
test version=floor: sdk-pack
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "22" { "" } else if version == "24" { "" } else { error("version must be 22 or 24") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock test
    docker compose run --rm test

# build the CLI and run the built binary against the conformance mock
e2e version=floor: sdk-pack
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "22" { "" } else if version == "24" { "" } else { error("version must be 22 or 24") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock e2e
    docker compose run --rm e2e

# every static check: tsc, eslint, prettier, knip, hadolint, actionlint, zizmor, shellcheck, gitleaks, typos, npm audit
lint version=floor: sdk-pack
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "22" { "" } else if version == "24" { "" } else { error("version must be 22 or 24") } }}
    export NODE_VERSION={{version}}
    trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build mock lint
    docker compose run --rm lint
    run() { docker run {{sandbox}} --network none --user "$(id -u):$(id -g)" -v "$(pwd)":/work:ro -w /work -e HOME=/tmp "$@"; }
    run {{hadolint_image}} /bin/hadolint docker/dev.Dockerfile docker/typos.Dockerfile
    run {{actionlint_image}} -color
    run {{zizmor_image}} --pedantic --offline --config zizmor.yml .github
    run {{shellcheck_image}} scripts/*.sh
    run {{gitleaks_image}} git --no-banner --redact --verbose /work
    docker build --quiet -f docker/typos.Dockerfile -t hushscript-cli-typos:local docker
    run hushscript-cli-typos:local --config _typos.toml
    # The one lint step with network access: it asks the registry about advisories and signatures.
    # Until @hushscript/sdk is published (docs/sdk-dependency.md) the signature check runs on a copy of the tree
    # without it, because the registry has no such package yet; every other package is checked.
    docker run {{sandbox}} "hushscript-cli-dev:node{{version}}" \
      sh -c 'timeout 300 npm audit --omit=dev --audit-level=high \
        && mkdir /tmp/signed && cp -r package.json package-lock.json node_modules /tmp/signed/ \
        && rm -rf /tmp/signed/node_modules/@hushscript && cd /tmp/signed && timeout 300 npm audit signatures'

# package build plus package-correctness checks, then install the packed CLI next to its production dependencies and run it.
# tsup bundles its config next to the file, so the (read-only) repo root gets a copy in /tmp.
build version=floor: sdk-pack
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "22" { "" } else if version == "24" { "" } else { error("version must be 22 or 24") } }}
    export NODE_VERSION={{version}}
    node_image={{ if version == "22" { node22_image } else { node24_image } }}
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
publish-dry-run version=floor: sdk-pack
    #!/usr/bin/env bash
    set -euo pipefail
    {{ if version == "22" { "" } else if version == "24" { "" } else { error("version must be 22 or 24") } }}
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

# lint, then test and e2e, then build; no argument runs Node 22 and 24
ci version="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{version}}" ]; then versions="{{version}}"; else versions="{{floor}} {{latest}}"; fi
    first="${versions%% *}"
    just lint "$first"
    for v in $versions; do
      just test "$v"
      just e2e "$v"
    done
    just build "$first"
