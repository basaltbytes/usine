# Supervisor inbox

The browser test `apps/web/src/features/conversations/screenshots.browser.test.tsx` captures these views at 1280 × 900 and 390 × 844 pixels using the app's dark theme and reduced motion. Each view has a `-desktop.png` and a `-phone.png` file.

- `881-inbox`: the conversations page with two unread conversations and nothing open. On a phone, the list.
- `881-empty-list`: the conversations page with no conversations.
- `881-panel-inbox`: the inbox in the sheet over the tokens page, with nothing open.
- `881-panel-thread`: the sheet with a running turn open beside the list. On a phone, the thread with its back control.
- `881-new-conversation`: the form for a new conversation, with the scope picker.
- `881-running-turn`: a running turn with streamed text and a running tool call, and a turn queued behind it.
- `881-finished-markdown`: an answered turn with its tool call and its answer as Markdown.
- `881-failed-turn`: a turn that failed because the orchestrator restarted.
- `881-setup-required`: a conversation while the supervisor isn't set up, without a prompt input.
- `881-read-only`: a conversation seen by a member without operate access, without a prompt input.

The conversations, members, events, read markers, and dates are test fixtures. The test runs no supervisor turn.
