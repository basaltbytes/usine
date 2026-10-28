# The image of each attempt's container on an SSH worker with Docker. The
# executor mounts the attempt's checkout and harness logins read-write, and its
# cached clone and credential directory read-only, and runs every command of
# the attempt with `docker exec` as the usine user. The harness versions
# match ../hetzner/cloud-init.yaml; packages/agents/test/preflight.test.ts
# checks them, and .github/workflows/worker-image.yml tags the image with them.
FROM debian:trixie-slim

# The Node.js major version of the image and of the worker machine:
# ../hetzner/render-cloud-init.sh puts it in ../hetzner/cloud-init.yaml.
ARG NODE_MAJOR=24
ARG PNPM_VERSION=11.20.0
ARG CLAUDE_CODE_VERSION=2.1.308
ARG CODEX_VERSION=0.159.2
# The worker's SSH user ID, so that files the attempt writes in its mounted
# checkout belong to that user. Preflight compares the two.
ARG USINE_UID=1000

RUN set -eu; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential bubblewrap ca-certificates chromium curl git gnupg iproute2 jq lsof procps tini; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh nodejs; \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g "pnpm@${PNPM_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# The harnesses write sessions and settings under their directories; the
# executor mounts only the login files inside them.
RUN useradd --uid "${USINE_UID}" --create-home --shell /bin/bash usine \
 && install -d -o usine -g usine -m 0700 \
      /home/usine/.claude /home/usine/.codex /home/usine/.cache /home/usine/.config

COPY --chmod=0755 container-init.sh /usr/local/bin/usine-container-init

# The attempt's checkout is a bind mount on another filesystem than the home
# directory, so pnpm would create its store in the checkout (#581). pnpm 11
# reads pnpm_config_store_dir, and earlier versions npm_config_store_dir.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    GH_NO_UPDATE_NOTIFIER=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    TURBO_CACHE_DIR=/home/usine/.cache/turbo \
    npm_config_store_dir=/home/usine/.local/share/pnpm/store \
    pnpm_config_store_dir=/home/usine/.local/share/pnpm/store

USER usine
WORKDIR /home/usine
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/usine-container-init"]
CMD ["sleep", "infinity"]
