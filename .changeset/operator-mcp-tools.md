---
"@usine/server": minor
---

The operator API is available as MCP tools, one for each operator operation, named by its endpoint identifier, such as `approve`. `POST /api/mcp` serves them over Streamable HTTP with the request's bearer token, and `usine mcp` serves them over stdio: with `--origin <url>`, it sends `USINE_TOKEN` to that instance; without it, it serves the running instance of the current folder with the local admin token. A caller lists only the tools that its permissions and operation ceiling permit, and every call runs the operation with the caller's credential, so permission checks and audit apply. A tool takes one object with the path parameters, the query parameters, and `body`. A result is the JSON response text, cut at 100 KB with a note that names a narrower operation. The change stream has no tool.

Device tokens can have an operation ceiling: the operation IDs that the token may call, such as `operator.approve`. `POST /api/tokens` accepts `operations` and an `expiresAt` expiry; `PUT /api/tokens/:id/scopes` replaces the ceiling with an array, removes it with `null`, and keeps it when the key is absent. A call outside the ceiling returns HTTP 403, except reading the session and signing out. `GET /api/auth/session` returns the ceiling, the token list returns the ceiling and the expiry, and **Tokens** shows both and sets them.

Every operation in `/api/openapi.json` has `x-usine-permission`, the permission it requires: `public`, `read`, `operate`, `maintain`, `admin`, `session`, `tokens`, `local`, or `setup`.
