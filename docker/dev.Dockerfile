ARG NODE_VERSION=22

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS node22
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS node24
FROM node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS node26

# node22, node24, and node26 above are the digest-pinned images; the build arg only selects one.
# hadolint ignore=DL3006
FROM node${NODE_VERSION} AS base
RUN groupadd --gid 10001 dev && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dev
ENV HOME=/tmp
WORKDIR /work

# The lockfile points @hushscript/sdk at .sdk/hushscript-sdk.tgz (see scripts/sdk-pack.sh and docs/sdk-dependency.md).
FROM base AS deps
COPY package.json package-lock.json ./
COPY .sdk/hushscript-sdk.tgz .sdk/hushscript-sdk.tgz
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM base AS dev
ENV PATH=/work/node_modules/.bin:$PATH
COPY --from=deps /work/node_modules node_modules
COPY --chown=10001:10001 . .
USER 10001:10001

# Production dependencies only: the consumer check in `just build` installs the packed CLI next to these.
FROM base AS proddeps
COPY package.json package-lock.json ./
COPY .sdk/hushscript-sdk.tgz .sdk/hushscript-sdk.tgz
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
