# Supervisor permission requests and standing grants

A supervisor turn reads with its member's access. A call of an operation that needs more than `read` runs at once only under a standing grant; otherwise usine stores a permission request, runs nothing, and the tool call returns that the request waits for a member. When every request of the turn has an answer, usine queues the conversation's next turn with the outcomes.

The tool call doesn't wait for the answer. A member may answer hours later, and a turn that holds its session open that long doesn't survive a restart, since not every harness can resume in the middle of a tool call ([ADR 0035](./0035-supervisor-conversations.md)). A stored request survives a restart. The outcomes reach the supervisor as the next turn's message instead of the tool result that the harness expected, so the context marks them as data.

Conversation text comes from other members, pull requests, and tool results, and any of it can instruct the model, so the turn's own credential stays read-only. An allowed call runs as the member who allowed it, with a credential that exists only for the call, has that member's current access within the call's scope, and can call only that operation. A grant applies only while the access of the member who created it permits the operation in its project, so a member can't give a turn more than they can do, and a grant stops applying when that member loses the access or leaves.

A request is answered once, and an allowed call runs at most once: usine stores the answer before the call and the outcome after it. A call that ran when the orchestrator stopped ends as interrupted and never runs again, because a retry or a run-again that ran twice can do more harm than a member's second look.

Operations outside a project, such as upgrades, can't have a standing grant. Neither can an operator message, an edit-and-retry, or a run-again: they send free text to a coding agent that can push, and under a grant, text from a pull request or an issue would reach that agent with no member reading it. Nor can a configuration write, which can rewrite a loop's prompt that agents run. A conversation on a project requests only operations in that project, because the members who read it and answer its requests are that project's. Members, tokens, provider logins, setup, and authentication have no tool, and role binding writes and configuration reverts make no request, since a turn would change who has access.

## Considered options

- **A proposal that the posting member confirms, with no standing grants**: a supervisor can't work a queue while members are away.
- **A tool call that waits for the answer**: lost at every restart.
- **Grants with their own access**: a member could give a turn more than they have.
- **Running an interrupted call again**: duplicate retries and runs.
