# syntax=docker/dockerfile:1
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Node sandbox — the standard code-execution workspace every node pins (story.0064).
# Published as ghcr.io/cogni-dao/node-template-sandbox; a node needing more tools
# builds FROM this image's digest instead of copying this file.
#
# Topology (one container, one public port):
#   $PORT (Caddy) ── GET /version → {"version","buildSha"} from COGNI_REPO_SHA
#                 └─ everything else (HTTP, SSE, WebSocket) → execd on 127.0.0.1:44772
# execd runs as PID 1 in init mode (reaps children, forwards signals) and owns
# Caddy as its entrypoint, so either process dying stops the container.
#
# Upstreams are pinned by version AND multi-arch index digest:
#   execd  — OpenSandbox (Apache-2.0) https://github.com/opensandbox-group/OpenSandbox
#            release docker/execd/v1.1.0; /execd is a static (CGO_ENABLED=0) Go binary.
#   caddy  — Apache-2.0 https://github.com/caddyserver/caddy v2.11.7; /usr/bin/caddy is static.
#   node   — node:22.23.5-trixie-slim, the app Dockerfile's Node major, so agent checks match CI.

FROM opensandbox/execd:v1.1.0@sha256:6cf7dba2f21f0b536e100563d841ac58a9f31c2b0a081b7ac76796a24d6f47e2 AS execd

FROM caddy:2.11.7@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af AS caddy

FROM node:22.23.5-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64

# Developer tools for coding a node repo: clone, pnpm install, targeted checks,
# open a pull request. No sudo, no package-manager access at runtime (the
# workload runs as an unprivileged user). pnpm matches the repo's packageManager.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    unzip \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@9.12.2 \
  && npm cache clean --force

COPY --from=execd /execd /usr/local/bin/execd
# Hardening-floor launcher; must stay root-owned and not group/world-writable.
COPY --from=execd /opt/opensandbox/opensandbox-launcher /opt/opensandbox/opensandbox-launcher
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY Caddyfile /etc/sandbox/Caddyfile
COPY execd.toml /etc/sandbox/execd.toml
COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint

RUN chmod 0755 /etc/sandbox /usr/local/bin/sandbox-entrypoint /opt/opensandbox /opt/opensandbox/opensandbox-launcher \
  && chmod 0644 /etc/sandbox/Caddyfile /etc/sandbox/execd.toml \
  && groupadd --gid 10001 sandbox \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/sandbox --shell /bin/bash sandbox \
  && mkdir -p /workspace \
  && chown sandbox:sandbox /workspace

# BUILD_SHA is a fallback only; the platform injects COGNI_REPO_SHA at runtime.
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA} \
    SANDBOX_VERSION=execd-v1.1.0 \
    PORT=8080 \
    HOST=0.0.0.0 \
    HOME=/home/sandbox \
    XDG_CONFIG_HOME=/home/sandbox/.config \
    XDG_DATA_HOME=/home/sandbox/.local/share \
    PYTHONUNBUFFERED=1 \
    LANG=C.UTF-8

USER 10001:10001
WORKDIR /workspace
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
