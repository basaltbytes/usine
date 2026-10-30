---
"@usine/config": minor
"@usine/orchestrator": patch
"@usine/server": minor
---

Add an exact browser origin allowlist with credentialed CORS and security headers on all server responses. Configure additional origins in `auth.origins` and restart; loopback browser origins now require an explicit entry unless they are the canonical server origin. Document public HTTPS deployment with Caddy, Cloudflare Tunnel, and Tailscale Serve.
