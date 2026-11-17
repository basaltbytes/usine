---
"@usine/orchestrator": minor
"@usine/server": minor
---

The web UI has a conversation panel for the supervisor. The conversation icon in the page header opens it over any page, and the `conversation` search parameter keeps it open across a reload. A new conversation takes a scope, the instance or a project the member can operate on, and a first message. The panel shows each turn's text and tool calls while it runs, the answer as Markdown, and queued, failed, and canceled turns, with **Cancel turn** for members who can operate on the scope. A member who can read but not operate sees the conversation without a composer, and the panel shows the setup reason while the supervisor isn't ready. **Conversations** in the sidebar lists the conversations the member can read.

Markdown in the web UI shows an image as a link to its URL instead of loading it, and links only `http`, `https`, and `mailto` URLs.

`GET /api/conversations` returns each conversation with its latest turn.
