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

4. Configure one credential per provider in `/etc/usine-gateway/secrets.env`: an Anthropic API key or Claude subscription token, and an OpenAI API key or the path to a dedicated ChatGPT auth file. For ChatGPT, create a separate login rather than copying a login another process refreshes:

   ```sh
   gateway_login_dir=$(mktemp -d)
   CODEX_HOME="$gateway_login_dir" codex login
   scp "$gateway_login_dir/auth.json" usine-gateway:/var/lib/usine-gateway/codex-auth.json
   ```

   Make the copied file writable only by the gateway service user and set `USINE_GATEWAY_CHATGPT_AUTH_FILE` to its path. Remove the temporary login directory after transfer. Use `claude setup-token` for a Claude subscription token. See [gateway variables](/reference/cli/#usine-gateway) for exact names. Remove directly proxied provider hosts from the egress allowlist and run `systemctl reload usine-gateway` on the gateway.

5. Create the private workers with the gateway’s [worker cloud-init instructions](https://github.com/basaltbytes/usine/blob/main/infra/hetzner/gateway/README.md). They must resolve the gateway domain, accept caller-token SSH variables, and use the proxy and gh socket. Add their SSH aliases with `ProxyJump usine-gateway`.
6. Copy the gateway admin-token setting into the instance’s private `.env` without printing it, then restart usine so the process reads it:

   ```sh
   (umask 077; ssh usine-gateway "grep '^USINE_GATEWAY_ADMIN_TOKEN=' /etc/usine-gateway/secrets.env" >> .env)
   chmod 600 .env
   usine restart
   ```

7. Edit the SSH worker in **Configuration > Workers**. Set gateway domain `gw.internal`, destination `usine-gateway`, admin-token variable `USINE_GATEWAY_ADMIN_TOKEN`, and the credential providers you configured. Save and inspect preflight.

## Check the result

Preflight reaches the admin API, checks the coordinator’s provider credential and model proxy from the orchestrator, and checks the gateway from the worker. A test attempt receives a caller token and uses `git.gw.internal` and `llm.gw.internal`. Its run page attributes usage to the configured API key or subscription plan.

The executor manages its own admin API forward; omit `LocalForward` from the gateway SSH alias. A private Hetzner worker reaches the gateway only. A Boat worker uses [the Tailscale connection procedure](/guides/connect-boat-to-a-gateway/). A long-lived worker outside the private network uses [worker-level tailnet settings](/guides/add-an-ssh-worker/#home-worker-on-a-mac).

Gateway slots use wire protocols. In the SSH worker’s `gateway.llm_providers`, use `anthropic-messages` for the Anthropic Messages API and `openai-responses` for the OpenAI Responses API or a ChatGPT login. Upgrade the gateway first, then the orchestrator. For one release, the gateway accepts the previous `/anthropic` and `/openai` prefixes and logs a deprecation warning so running attempts can finish. A gateway without credential reporting fails preflight with an instruction to upgrade `@usine/gateway`. Credential environment-variable names stay the same. See the [worker reference](/reference/configuration/workers/#gateway).

The attempt’s Pi coordinator uses the gateway’s credentials through an SSH forward and the attempt’s caller token. The orchestrator host needs no provider login. Set `parent_model` in the instance settings or agent frontmatter to `openai-codex/<model>` for a ChatGPT subscription, `openai/<model>` for an OpenAI API key, or `anthropic/<model>` for an Anthropic API key. Include the matching wire protocol in the worker’s `gateway.llm_providers`. Pi cannot use a Claude subscription token; Claude Code children can.

Coordinator usage counts under `chatgptPlan` for a gateway ChatGPT login or `apiKeys` for an API key. After an orchestrator restart, the coordinator waits for its attempt’s gateway attachment before making model requests. Workers without a gateway keep the coordinator’s local Pi login.
