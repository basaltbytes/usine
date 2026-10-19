---
"@usine/gateway": minor
---

`usine-gateway` reloads on SIGHUP (`systemctl reload usine-gateway`): it reads its environment files and its allowlist file again and replaces the egress allowlist and the LLM provider settings, and leaves the attachments, the admin API, the listening sockets, and open tunnels as they are. An allowlist that does not parse, or invalid provider settings, keep what is in force and the log says why. The domain, the listeners, the admin token, and the caller key still need a restart, and a reload that finds one of them changed logs it. The command reads the environment files that `USINE_GATEWAY_ENVIRONMENT_FILES` names, separated by `:`, over the process environment. `SettingsInForce` holds the allowlist and providers requests are decided with, and `@usine/gateway/node` exports `GatewayReload`.

The gateway VM's unit in `infra/hetzner/gateway` sets `USINE_GATEWAY_ENVIRONMENT_FILES` instead of `EnvironmentFile=` and adds `ExecReload=`; its README lists the steps for an existing gateway.
