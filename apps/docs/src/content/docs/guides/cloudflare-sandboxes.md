---
title: Run attempts in Cloudflare sandboxes
description: Deploy the sandbox Worker and connect a Cloudflare worker.
---

Deploy a sandbox Worker to your Cloudflare account and run each attempt in its own container.

## Prerequisites

Instance admin access, a Cloudflare Workers Paid account with Zero Trust access, Wrangler authentication, Docker for image builds, a matching usine checkout with dependencies installed, and API keys for each rostered harness. All workers in the instance must use the Cloudflare kind; Pi children are unsupported.

## Procedure

1. Build the sandbox Worker and its dependencies:

   ```sh
   pnpm --filter @usine/cloudflare... build
   cd packages/cloudflare
   ```

2. Set the Worker name in `wrangler.jsonc`. Set `ALLOWED_HOSTS` to comma-separated package hosts required by your repositories, such as `registry.npmjs.org`. GitHub and provider hosts use dedicated outbound handlers.
3. In Cloudflare Zero Trust, create an Access service token. Store the same client ID and secret on the Worker:

   ```sh
   npx wrangler secret put ACCESS_CLIENT_ID
   npx wrangler secret put ACCESS_CLIENT_SECRET
   npx wrangler deploy
   ```

   Record the printed HTTPS origin. Deployment builds the image from `image/Dockerfile`. The container application uses the `durable_object` scheduling policy and cannot guarantee EU-only placement.

4. Store the Access values and provider keys in the instance `.env` as `USINE_CF_ACCESS_CLIENT_ID`, `USINE_CF_ACCESS_CLIENT_SECRET`, and the provider variable names you will configure. Restart usine to read them.
5. Open **Configuration > Workers > New**. Choose `cloudflare`, set the deployed Worker origin, Access variable names, image `usine`, and an instance type such as `standard-4`. Set each model provider and its API-key variable name. Save.
6. If changing executor kind, replace the worker configuration while the orchestrator is stopped and restart it. [Configuration commands](/reference/configuration/config/) describes complete imports for changes the running UI cannot apply.

## Check the result

Preflight checks the Access token, image, provider keys, and harness versions in a temporary sandbox. A test attempt uses its own sandbox and reports API-key usage. Its container has placeholder credentials; the Worker’s outbound handlers inject the real tokens.

A sandbox can reach GitHub, configured providers, and the allowed package hosts. It has no interactive terminal. A dropped command stream can reattach to stored output. On a platform stop, usine attempts to salvage the checkout and retries through an infrastructure failure.

Requests to allowlisted hosts preserve their headers and redirect policy. WebSocket upgrades use the Cloudflare platform connection.

A retained sandbox stays billable while held for recovery. Startup reattaches live attempts or salvages retained work. A stopped container loses its disk, so recovery depends on pushed salvage. If a sandbox remains after an attempt, inspect the orchestrator and Worker logs before deleting it. [Cloudflare settings](/reference/configuration/workers/#cloudflare-connection) lists fields and defaults.

Sandbox API error responses identify the error with `_tag` and the affected sandbox with `name`. Worker logs retain the error type when reporting a sandbox failure.
