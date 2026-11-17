---
"@usine/orchestrator": minor
"@usine/server": minor
---

The web UI has a supervisor inbox. The conversation icon in the page header opens it over any page and shows how many conversations have unread activity; **Conversations** in the sidebar opens it as a full page. The inbox lists the conversations the member can read by latest activity, with a preview of the last message, the last turn's state while it is queued, running, or failed, and a mark on unread ones, beside the open conversation. A new conversation takes a scope, the instance or a project the member can operate on, and a first message. A conversation shows each turn's text and tool calls while it runs, the answer as Markdown, and queued, failed, and canceled turns, with **Cancel turn** for members who can operate on the scope. A member who can read but not operate sees conversations without a prompt input, and the inbox shows the setup reason while the supervisor isn't ready.

Markdown in the web UI shows an image as a link to its URL instead of loading it, and links only `http`, `https`, and `mailto` URLs.

`GET /api/conversations` returns each conversation with its latest turn, the sequence and a one-line preview of its latest message, its latest activity time, and, for a member, whether it has unread activity, latest activity first. `POST /api/conversations/:conversation/read` moves the calling member's read marker, which never moves back. A failed turn or a message from someone else after the marker makes a conversation unread; the member's own messages don't.
