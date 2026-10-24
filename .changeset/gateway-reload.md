---
"@usine/gateway": minor
---

`usine-gateway` reloads on SIGHUP (`systemctl reload usine-gateway`): it rereads its environment files and allowlist file and replaces the egress allowlist and LLM provider settings, without dropping attachments or open connections. If the new settings are invalid, it keeps the current ones and logs why; the domain, listeners, admin token, and caller key still need a restart.

The command reads the environment files listed in `USINE_GATEWAY_ENVIRONMENT_FILES`, separated by `:`, and `@usine/gateway/node` exports `GatewayReload`. The gateway unit in `infra/hetzner/gateway` sets `USINE_GATEWAY_ENVIRONMENT_FILES` instead of `EnvironmentFile=` and adds `ExecReload=`; its README lists the steps for an existing gateway.
