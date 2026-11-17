# Supervisor conversations

The browser test `apps/web/src/features/conversations/screenshots.browser.test.tsx` captures these views at 1280 × 900 and 390 × 844 pixels using the app's dark theme and reduced motion. Each view has a `-desktop.png` and a `-phone.png` file.

- `881-list`: the conversations list with failed, queued, and answered last turns.
- `881-empty-list`: the conversations list with no conversations.
- `881-new-conversation`: the panel's form for a new conversation, with recent conversations.
- `881-running-turn`: a running turn with streamed text and a running tool call, and a turn queued behind it.
- `881-finished-markdown`: an answered turn rendered as Markdown.
- `881-failed-turn`: a turn that failed because the orchestrator restarted.
- `881-setup-required`: the panel and list while the supervisor isn't set up, without a composer.
- `881-read-only`: a conversation seen by a member without operate access, without a composer.

The conversations, members, events, and dates are test fixtures. The test does not run a supervisor turn.
