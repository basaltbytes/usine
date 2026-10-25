# @usine/cloudflare

The Cloudflare Worker that runs each usine Attempt in its own sandbox, for `cloudflare` Workers in `usine.yaml` ([#551](https://github.com/basaltbytes/usine/issues/551)). You deploy it to your Cloudflare account; usine's executor calls it over HTTPS with a Cloudflare Access service token.

Each sandbox is a Durable Object that owns one container, started from an image in the Worker's configuration with the [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/) and the [Sandbox SDK 1.0](https://developers.cloudflare.com/sandbox/). The container has no internet access. Its requests for GitHub, the LLM providers, and the allowlisted hosts go to outbound handlers in the Worker, which hold the Attempt's credentials, so the container never receives them:

| Host in the sandbox | Handler | Upstream |
| --- | --- | --- |
| `github.com`, `api.github.com` over HTTPS | Adds the Attempt's installation token | GitHub |
| `anthropic.usine.internal` over HTTP | Replaces the placeholder key with the Anthropic API key | `https://api.anthropic.com` |
| `openai.usine.internal` over HTTP | Replaces the placeholder key with the OpenAI API key | `https://api.openai.com` |
| Each host in `ALLOWED_HOSTS` over HTTPS | Forwards the request unchanged | The host |

While a sandbox has no installation token or no key for a provider, such as a sandbox that the executor keeps after its Attempt, the handler for that host refuses every request with status 403. `ALLOWED_HOSTS` can't name a GitHub or provider host.

HTTPS interception needs the container to trust Cloudflare's container certificate authority. The executor sets `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `SSL_CERT_FILE`, and `NODE_EXTRA_CA_CERTS` to it for every command, as Cloudflare's coding-agent runner does. Claude Code and Codex use plain HTTP to their handlers, with a placeholder key.

## Entry points

| Import | Contents |
| --- | --- |
| `@usine/cloudflare` | `SandboxApi`, the JSON API contract for `HttpApiClient.make` in the executor, with its records and errors, `sandboxName`, the Access header names, and the exec and attach stream paths. |
| `@usine/cloudflare/stream` | The messages of the exec and attach WebSocket streams. |
| `@usine/cloudflare/harness` | The environment that points git, gh, Claude Code, and Codex at the outbound handlers, and the sandbox paths. |
| `src/worker.ts` | The Worker that `wrangler.jsonc` deploys: `AttemptSandbox`, `SandboxRegistry`, and the outbound handlers. It runs only on Cloudflare. |

## The sandbox API

Every request needs the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers of the service token that the Worker is configured with. The Worker refuses any other request with status 401.

| Route | Purpose |
| --- | --- |
| `GET /v1/health` | The protocol version and the image names. |
| `GET /v1/sandboxes?owner=<instance>.<worker>` | The sandboxes of one usine instance's Worker, each with whether its container runs. |
| `PUT /v1/sandboxes/<name>` | Creates the sandbox of an Attempt, or returns it if it already runs that Attempt. |
| `GET /v1/sandboxes/<name>` | One sandbox. |
| `PUT /v1/sandboxes/<name>/credentials` | Replaces the handlers' credentials, such as a renewed installation token. |
| `POST /v1/sandboxes/<name>/hold` | Keeps the container running past its lease until the sandbox is destroyed. |
| `POST /v1/sandboxes/<name>/stop` | Stops every command that still runs in the sandbox. |
| `DELETE /v1/sandboxes/<name>` | Destroys the container and forgets the sandbox. |
| `GET /v1/sandboxes/<name>/processes/<process>` | A command's state and output size, from its process files. |
| `GET /v1/sandboxes/<name>/exec` (WebSocket) | Runs one command with `sh -c`, with its stdin, stdout, stderr, and exit code on the stream. |
| `GET /v1/sandboxes/<name>/processes/<process>/attach?stdout=<n>&stderr=<n>` (WebSocket) | Resumes a command's output after the given byte offsets, then sends its exit code. |

Each command runs as the `usine` user in `/home/usine`, with `HOME` set, since the platform passes a command only the image's `PATH`. It runs in its own session, with its process ID, output, and exit code in files under `/home/usine/.usine/processes/<process>`. If the stream that started a command closes, the command's stdin closes, and its output keeps going to the files, so a later request can attach or read its state. The Worker closes the stream without an exit code when it can't read the command's output or exit code from the container, so the client attaches from the bytes it received.

A keepalive alarm keeps the container running for two hours after the last create, credential renewal, or command, then lets the platform stop it after ten minutes of inactivity. A held sandbox keeps running until it's destroyed: usine holds the sandbox of a checkout that it keeps, such as one with unpushed work. A stopped container loses its disk.

When Cloudflare restarts a host or replaces an instance, it sends the container SIGTERM and stops it up to 15 minutes later. The image's init (`image/init.sh`) writes the time to `/home/usine/.usine/draining` and keeps the container running, and each sandbox summary reports `draining` while the file exists. The executor then drains the Attempt: it salvages the checkout and destroys the sandbox before the container stops.

## Deploy

You need a Cloudflare account with Workers Paid, which Containers require, and [Wrangler](https://developers.cloudflare.com/workers/wrangler/) logged in to it. The image is linux/amd64; Wrangler builds it with your local Docker.

1. In a usine checkout, build the Worker:

   ```sh
   pnpm install
   pnpm --filter @usine/cloudflare... build
   cd packages/cloudflare
   ```

2. In `wrangler.jsonc`, set `name` to your Worker's name, and set `ALLOWED_HOSTS` to the package registries your repositories install from.

3. Create a Cloudflare Access service token in Zero Trust under **Access** > **Service credentials** > **Service Tokens**, and store its client ID and client secret on the Worker:

   ```sh
   npx wrangler secret put ACCESS_CLIENT_ID
   npx wrangler secret put ACCESS_CLIENT_SECRET
   ```

   To also check the token at Cloudflare's edge, add an Access application for the Worker's hostname with a Service Auth policy that allows that token.

4. Deploy the Worker and its image:

   ```sh
   npx wrangler deploy
   ```

   The containers use the `durable_object` scheduling policy, which Wrangler can't undo for the application.

5. Add the Worker to `usine.yaml`, and set the token and the provider keys in the orchestrator's environment. See [Run attempts on Cloudflare](https://docs.usine.dev/guides/cloudflare-sandboxes/).

## EU placement

The Sandbox SDK 1.0 needs the `durable_object` scheduling policy, which rejects placement constraints, including `jurisdiction: "eu"`. Containers can't be kept in the EU until Cloudflare adds placement to that policy.

## Develop

`pnpm test` runs unit tests in Node: the routes and streams against fake ports, and the process file scripts with the local `sh`. The Durable Object's container calls need Cloudflare's container runtime, so no test runs the Worker itself.
