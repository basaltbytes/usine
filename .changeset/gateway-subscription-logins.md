---
"@usine/gateway": minor
---

The gateway holds a Codex ChatGPT login. `USINE_GATEWAY_CHATGPT_AUTH_FILE` names the `auth.json` that `codex login` writes; the gateway keeps its tokens in memory, refreshes the access token before it expires, one refresh at a time, and writes the rotated tokens back to the file through a temporary file with mode 0600. Codex's `/openai/v1/responses` goes to `USINE_GATEWAY_CHATGPT_UPSTREAM` (default `https://chatgpt.com/backend-api/codex`) with the access token and `ChatGPT-Account-ID`. A failed refresh answers 401 with `provider-login-unavailable` and sends nothing upstream. A reload rereads the file and keeps the tokens in memory if the file has their refresh token or one they replaced. The admin API reports the login as a `subscription`.

`llm.<domain>` serves only the routes Claude Code and Codex call, for every credential: `/anthropic/v1/messages`, `/anthropic/v1/messages/count_tokens`, `/anthropic/v1/models` and `/anthropic/v1/models/MODEL`, and `/openai/v1/responses`, `/openai/v1/responses/compact`, and `/openai/v1/models`. Other paths, percent-encoded separators, and dot segments are refused with `unsupported-path` before any credential is used.

`OpenAiProvider` takes a `credential`, an `OpenAiApiKey` or a `ChatGptLogin`, instead of `key`. `ConflictingProviderCredentials` replaces `ConflictingAnthropicCredentials` and names the provider. `gatewayServices` includes `ChatGptLogins`, which needs a `FileSystem`; `gatewayLayer` provides Node's.
