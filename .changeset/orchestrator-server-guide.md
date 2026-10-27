---
"@usine/server": patch
---

The macOS sleep warning of `usine up` also suggests running the orchestrator on an always-on server, and links to the new guide [Run the orchestrator on a server](https://docs.usine.dev/guides/run-the-orchestrator-on-a-server/) ([#609](https://github.com/basaltbytes/usine/issues/609)). The guide creates a Hetzner Cloud server in the gateway's private network with `infra/hetzner/gateway/gateway.sh orchestrator`, runs `usine up` in a systemd service, publishes the web UI on the tailnet with `tailscale serve`, and moves an instance there from a laptop.
