---
title: Configure a gateway
description: Proxy SSH workers’ GitHub and model credentials through a gateway.
---

Set up a gateway that keeps real GitHub and model credentials off private SSH workers.

## Prerequisites

Instance admin access, a matching usine checkout, a Hetzner project, the `hcloud` CLI, an SSH key registered as `usine-worker`, Tailscale on the orchestrator, and provider credentials. The [gateway setup reference](https://github.com/basaltbytes/usine/blob/main/infra/hetzner/gateway/README.md) describes network and firewall requirements.

## Procedure

1. Create the network and gateway from the checkout. Replace the CIDR with the orchestrator’s public address:

   ```sh
   ssh-add ~/.ssh/usine_worker
   ORCHESTRATOR_CIDR=203.0.113.10/32 SSH_KEY=usine-worker \
     ./infra/hetzner/gateway/gateway.sh create
   ```

2. Wait for cloud-init at the printed gateway address, then join the gateway to the orchestrator’s tailnet:

   ```sh
   ssh root@203.0.113.30 cloud-init status --wait
   ./infra/hetzner/gateway/gateway.sh tailnet-up
   ```

   Complete the printed login. Use a tagged device or configure key expiry for unattended access. Add an SSH alias `usine-gateway` using its tailnet address, `User root`, the identity file, and `HostKeyAlias` set to the trusted public address. Check `ssh usine-gateway true` before removing the gateway’s public SSH rule.

3. Install the service:

   ```sh
   GATEWAY_SSH=usine-gateway ./infra/hetzner/gateway/gateway.sh install @usine/gateway
   ```

4. Install the pinned harnesses on the orchestrator, where usine starts their login commands:

   ```sh
   npm install --global @anthropic-ai/claude-code@2.1.311 @openai/codex@0.172.0
   ```

   Linux also needs `script` from util-linux and `curl` on the gateway. macOS includes `script`.

5. Create the private workers with the gateway’s [worker cloud-init instructions](https://github.com/basaltbytes/usine/blob/main/infra/hetzner/gateway/README.md). They must resolve the gateway domain, accept caller-token SSH variables, and use the proxy and gh socket. Add their SSH aliases with `ProxyJump usine-gateway`.
6. Copy the gateway admin-token setting into the instance’s private `.env` without printing it, then restart usine so the process reads it:

   ```sh
   (umask 077; ssh usine-gateway "grep '^USINE_GATEWAY_ADMIN_TOKEN=' /etc/usine-gateway/secrets.env" >> .env)
   chmod 600 .env
   usine restart
   ```

7. Edit the SSH worker in **Configuration > Workers**. Set gateway domain `gw.internal`, destination `usine-gateway`, admin-token variable `USINE_GATEWAY_ADMIN_TOKEN`, and leave credential providers empty until you connect. Save.
8. Open **Configuration > Settings > Provider connections**. Select **Connect Claude** and **Connect ChatGPT** for the gateway. ChatGPT displays a device code; enable device authorization in your ChatGPT security settings if required. Claude opens an authorization page and asks you to paste the resulting code into usine. **Use an API key** connects either provider with usage-based billing. Settings lists every provider that the gateway serves; a provider that takes only an API key shows its key field.

   For a headless orchestrator, run these from the instance folder while `usine up` runs:

   ```sh
   usine login claude
   usine login chatgpt
   ```

   Each gateway reports its connection state separately. A gateway that cannot report its state shows an error beside its destination; healthy gateways keep their connection controls. A gateway without the provider-credentials admin API shows that it is older than the orchestrator and names the `@usine/gateway` version to install. A CLI command with `--target` checks the selected gateway.

   Add `--target usine-gateway` when the instance has several gateways. Add `--api-key` for masked API-key entry. usine transfers completed credentials through the gateway admin API over SSH, saves them with mode `0600`, and updates the workers’ `llm_providers` in a configuration revision. Claude selects `anthropic-messages`; ChatGPT selects `openai-responses`; `usine login opencode-go --api-key` selects `opencode-go`. Routing changes only for providers that the orchestrator's harnesses use. No provider credential requires a manual SSH transfer or service reload. For another provider, run `usine login <provider ID> --api-key`.

   Settings shows each credential kind, reported expiry, and last refresh. **Replace** starts a separate login and keeps the current credential until authorization succeeds. **Disconnect** removes the managed credential and worker routing. `usine logout claude` and `usine logout chatgpt` perform the same actions.

   Claude uses a subscription token from `claude setup-token`, which expires after one year and has no refresh token. The token does not include its expiry date, so Settings shows **Not included with token** for expiry and **Not applicable** for last refresh, with a reminder to replace the login before it expires. ChatGPT uses a refreshable OAuth login and reports its expiry and last refresh. Gateways that omit refresh capability keep **Not reported** for missing dates; upgrade the gateway to get this distinction.

## Check the result

Preflight reaches the admin API and the gateway from the worker. A test attempt receives a caller token and uses `git.gw.internal` and `llm.gw.internal`. Its run page attributes usage to the configured API key or subscription plan.

The executor manages its own admin API forward; omit `LocalForward` from the gateway SSH alias. A private Hetzner worker reaches the gateway only. A Boat worker uses [the Tailscale connection procedure](/guides/connect-boat-to-a-gateway/). A long-lived worker outside the private network uses [worker-level tailnet settings](/guides/add-an-ssh-worker/#home-worker-on-a-mac).

Each model provider that usine knows has one slot at the gateway, which holds its credential. In the SSH worker’s `gateway.llm_providers`, use `anthropic-messages` for the Anthropic API, `openai-responses` for the OpenAI API or a ChatGPT login, and `opencode-go` for the OpenCode Go plan. See the [worker reference](/reference/configuration/workers/#gateway).

## Upgrade the gateway

Upgrade the gateway before the orchestrator, to the `@usine/gateway` version that the new `@usine/server` release depends on:

1. List the dependencies of the `@usine/server` version that you install next, and note the `@usine/gateway` version:

   ```sh
   npm view @usine/server@<version> dependencies
   ```

2. Install that version on the gateway:

   ```sh
   GATEWAY_SSH=usine-gateway ./infra/hetzner/gateway/gateway.sh install @usine/gateway@<gateway-version>
   ```

3. [Upgrade the orchestrator](/guides/upgrade-an-instance/).

For one release, an upgraded gateway also accepts the previous `/anthropic` and `/openai` prefixes and logs a deprecation warning, so attempts configured by the previous orchestrator can finish.

Preflight checks that the gateway serves each slot in a worker's `llm_providers`, and every route under it that the orchestrator's harnesses call. A gateway that lacks one fails preflight with an instruction to upgrade `@usine/gateway` on it. A gateway newer than the orchestrator works with it, even when the gateway holds a credential for a slot that the orchestrator doesn't know: the orchestrator ignores slots and routes that it doesn't use.

If the orchestrator is upgraded first, attempts keep running. While the gateway reports its providers as `anthropic` and `openai` instead of slots, attempts call `/anthropic` and `/openai/v1`, the coordinator and supervisor do the same, and the orchestrator logs a warning once for each worker. **Needs attention** shows **Gateway upgrade needed** for each worker behind a gateway that is older than the orchestrator, including a gateway without the provider-credentials admin API that **Settings > Provider connections** uses, and a gateway that doesn't report the slots it serves, which preflight then can't check. Such a gateway serves `anthropic-messages` and `openai-responses`; a worker that lists another slot fails preflight until you upgrade the gateway. After you upgrade the gateway, the next preflight switches attempts to the slot paths and removes the entry; run [worker preflight](/guides/run-worker-preflight/) to check at once. The coordinator and supervisor switch within two minutes, without a restart. A gateway without credential reporting fails preflight with an instruction to upgrade `@usine/gateway`.

## Orchestrator credentials

The supervisor runs on the orchestrator host and sends model requests through an SSH forward to the first gateway declared by the instance's SSH workers, so the orchestrator host needs no provider login. An attempt that an earlier version started with a Pi parent session uses the same route when an orchestrator restart reattaches it. Restart usine after changing which gateway appears first.

## Manual credential configuration

The gateway also accepts credentials in `/etc/usine-gateway/secrets.env`: `ANTHROPIC_API_KEY` or `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN`, `OPENAI_API_KEY` or `USINE_GATEWAY_CHATGPT_AUTH_FILE`, and `OPENCODE_GO_API_KEY`. Obtain a Claude subscription token with `claude setup-token`. For ChatGPT, use an empty `CODEX_HOME` with `codex login --device-auth`, copy its `auth.json` to the gateway with mode `0600` and ownership by the service user, then remove the temporary copy. A refresh token must have one owner.

Set the corresponding `llm_providers` on workers and reload the gateway service after manual changes. Managed connections take precedence over environment credentials, including after disconnect and reload. [Gateway variables](/reference/cli/#usine-gateway) documents the environment settings.
