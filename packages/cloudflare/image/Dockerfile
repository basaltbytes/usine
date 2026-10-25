# The image of a usine sandbox: Node.js 22, pnpm, Git, gh, Claude Code, and Codex, with the
# Sandbox SDK's file helper. The npm versions match infra/hetzner/cloud-init.yaml;
# test/image.test.ts checks them.
FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-tools

FROM --platform=linux/amd64 docker.io/library/node:22-bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git gpg procps tini \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11.20.0 @anthropic-ai/claude-code@2.1.308 @openai/codex@0.159.2 \
  && npm cache clean --force

# Files in @cloudflare/sandbox runs this helper to read the process files.
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

RUN useradd --create-home --shell /bin/bash usine \
  && install -d -o usine -g usine /home/usine/.codex /home/usine/.usine/processes /home/usine/workspace
COPY --chown=usine:usine codex-config.toml /home/usine/.codex/config.toml

USER usine
WORKDIR /home/usine
ENV HOME=/home/usine

# tini reaps the commands that the Worker starts; the container runs until the Worker destroys it
# or its inactivity timeout passes.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
