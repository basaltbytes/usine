---
title: Connect an MCP client
description: Give Claude Code or Codex on a laptop the operator API as MCP tools.
---

Connect a coding agent on your laptop, such as Claude Code or Codex, to an instance. The agent reads and operates the instance through MCP tools, one for each operator API operation, such as `overview`, `detail`, and `approve`.

## Prerequisites

- An instance that your laptop reaches over HTTPS, such as `https://usine.example.com`.
- An enrolled GitHub identity with role bindings on the projects that the agent works on.
- For the stdio form, `@usine/server` installed on the laptop, so that the `usine` command is available.

## Procedure

1. Create a device token for the agent. Run:

   ```sh
   usine sign-in https://usine.example.com
   ```

   Open the printed GitHub device page and enter the code. The CLI prints the token once; store it in a secret manager. To create the token from a browser instead, open **Tokens** and select **Create token**.

2. Narrow the token. Open **Tokens** in a browser session and select **Edit scopes** on the device entry:
   - Keep only the scopes that the agent needs, such as **Read** and **Operate** on one project.
   - Under **Operations**, list the operation IDs that the agent may call, separated by commas, such as `operator.overview, operator.detail, operator.approve`. The [Operator API reference](/reference/operator-api/) lists every operation ID.
   - Select **Save scopes**.

   A token that you create on **Tokens** takes the same fields, and also an optional expiry.

3. Add the instance to the client. For Claude Code, run:

   ```sh
   claude mcp add --transport http usine https://usine.example.com/api/mcp --header "Authorization: Bearer <token>"
   ```

   For Codex, add the server to `~/.codex/config.toml` and set `USINE_TOKEN` to the token in the environment that starts Codex:

   ```toml
   [mcp_servers.usine]
   url = "https://usine.example.com/api/mcp"
   bearer_token_env_var = "USINE_TOKEN"
   ```

   To use stdio instead of HTTP, start `usine mcp` as a local command that reads the token from `USINE_TOKEN`:

   ```sh
   claude mcp add --env USINE_TOKEN=<token> usine -- usine mcp --origin https://usine.example.com
   codex mcp add usine --env USINE_TOKEN=<token> -- usine mcp --origin https://usine.example.com
   ```

   On the instance machine, `usine mcp` without `--origin`, run in the instance folder, serves the running instance with the local admin token. That token has instance admin access.

## Check the result

In Claude Code, run `/mcp` and open **usine**; in Codex, run `/mcp`. The list contains only the tools that the token's scopes and operations permit. Ask the agent to read the overview of a project to confirm that the tools work.

## How tool calls work

- Each tool call is an operator API request with the token. The instance checks the permission again, including the project in the path, and records the token's member on approvals and other actions.
- A tool's input is one object with the operation's path parameters, query parameters, and `body` for a request body.
- A result is the JSON response text. A result over 100 KB is cut at that size and followed by a note that names a narrower operation, such as `desk` or `project` for `overview`.
- A refused request returns an error result with the HTTP status and the error body. A tool outside the token's list is unknown to the server.
- The change stream, `GET /api/changes`, has no tool.
- The client reads the tool list when it connects. After you change the token's scopes or operations, reconnect the server in the client.

Revoke the device entry under **Tokens** to end the agent's access.
