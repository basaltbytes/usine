# OpenCode children use a leased HTTP server

OpenCode 2.2.5's ACP implementation rejects a second `session/prompt` while the first prompt runs. A coding-agent child must accept guidance while a command is active, so ACP cannot implement the child contract. The HTTP session inbox accepts `delivery: "steer"` during execution and reports delivery separately.

The adapter implements the existing `HarnessRuntime` and `RunningSession` interfaces. Its `OpenCodeServer` service owns process startup, authenticated HTTP, SSE, and SSH forwarding. Existing child-host command construction supplies the worker environment, container invocation, and PID file. A separate vendor SDK or changes to the executor's host interface are unnecessary.

Each child starts `opencode serve --stdio --hostname 127.0.0.1 --port 0`. A generated password protects the loopback server. The CLI prints its bound URL as JSON and exits when stdin closes. The adapter subscribes to events before submitting work and closes stdin before publishing completion. An SSH child uses a second SSH connection with a local TCP forward; worker containers share the host network. Admission refuses sandbox placement because its shell transport cannot forward TCP.

Repository configuration and plugins are disabled through OpenCode's project-config setting. Repository AGENTS instructions remain enabled. The adapter applies an allow permission policy; an unexpected permission request fails the child instead of waiting for terminal input. Model catalogs use the bundled snapshot without a startup models.dev fetch, and automatic updates and sharing are disabled.

Gateway and provisioned-key descriptors configure the OpenAI Responses provider and a separate `XDG_DATA_HOME` for each attempt. OpenCode stores credentials in its data database and prioritizes saved credentials over environment keys, so an isolated data directory prevents a saved host login from changing the selected credential. Host-login sessions use the worker's normal data directory. The pool follows the active OpenAI OAuth connection or gateway credential kind; keys and compatible endpoints use `apiKeys`.

The adapter declares saved-session handoff, steering, interruption, model checks, tokens, and cost. It does not declare durable coordination, usine tools, or plan windows. OpenCode supports MCP, but this adapter supplies no usine tool server. The coordinator continues to require the existing durable journal guarantees.

The real CLI contract and protocol checks are recorded in [the OpenCode spike](../research/opencode-adapter.md).
