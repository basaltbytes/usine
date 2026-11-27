---
"@usine/core": minor
"@usine/agents": minor
"@usine/gateway": minor
"@usine/executor": minor
"@usine/cloudflare": minor
"@usine/server": minor
---

OpenCode agents can run models of the OpenCode Go plan through the gateway. Connect the plan's key with `usine login opencode-go --api-key`, or `OPENCODE_GO_API_KEY` on the gateway, and set `model` to `opencode-go/<model ID>`, such as `opencode-go/glm-5.3`. A model ID without a provider stays an OpenAI model. The gateway holds the key, and the worker gets only the caller token and the URL of the gateway's `opencode-go` slot.

- `@usine/core`: the provider catalog adds `opencodeGo`, whose slot `opencode-go` serves `/chat/completions` and `/responses` at the plan's OpenAI upstream, `/messages` at its Anthropic upstream, and `/models/{model}:streamGenerateContent` at its Google upstream, each with the key in that protocol's header. It passes OpenCode's session headers and the Anthropic version and beta headers, and accepts only an API key.
- `@usine/gateway`: the gateway serves the `opencode-go` slot and returns the plan's error bodies unchanged, so OpenCode recognizes its limits.
- `@usine/agents`: a `HarnessDescriptor` lists the providers that an attempt API key outside a sandbox doesn't reach in `gatewayOnly`, and returns the others as `apiKeyProviders`. A `HarnessCredential` names the variable of each provider's slot URL in `slots`, which `slotEnvironment` renders for the providers that a gateway holds. OpenCode lists `openai` and `opencode-go`, reads the provider of the model from OpenCode's `provider/model` notation, refuses a provider that it doesn't list with the list in the message, and refuses a Go model outside the gateway route. Its session allows only the model's provider, and preflight and launch check the model against that provider.
- `@usine/cloudflare`: the Worker serves `opencode-go.usine.internal` for a sandbox with the plan's key, and denies it otherwise, as for every catalog provider.
- `@usine/executor`: a gateway route sets the URL of each slot of a harness that the gateway holds in the variable that the descriptor names, and a provisioner's `api_keys` give an attempt only a key that the harness reaches with one. The gateway upgrade notice lists only the paths that changed with slots.
- `@usine/server`: the agent and worker references document the OpenCode Go provider.
