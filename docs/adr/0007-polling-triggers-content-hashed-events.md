# Polling with a content-hash ledger opens every event; webhooks are hints

usine polls GitHub. A conditional REST request lists each repository's changed items, so an idle repository costs an uncounted 304, and each changed item gets one GraphQL snapshot of its payload slice.

An event opens when a loop's `if:` matches and the key of loop, repository, item, and a hash of the slice without timestamps is new. The ledger is permanent, so usine never acts twice on one state unless the operator asks; the REST cursor only saves requests. A new loop acts on every item that already matches, with no baseline. A state whose run was canceled acts again after the item leaves it and returns. A schedule opens one event per repository per tick; after downtime, only the latest missed tick fires.

A newer state supersedes, and a failed match revokes, only runs without a started attempt. Label-protocol loops unmatch their own trigger, and derived-state loops change their item as they work, so either would otherwise cancel itself.

Mergeability and checks change without a new `updated_at`, so polling also fetches an open pull request after its base branch moves and while either is unsettled.

Webhook deliveries are hints: requests to fetch sooner, through the same ledger. A hint never opens an event, so a lost one costs only latency. Hints come from the App's delivery log, a signed endpoint, or usine's own board moves. Setup creates the App webhook active, because only the App's settings page can activate it later.

## Considered options

- **Webhooks as the event source**: GitHub never redelivers on its own, so a lost delivery would lose work.
- **GraphQL change detection**: no conditional requests, so idle polls spend rate limit.
- **Keys on `updated_at`**: fire on changes the slice can't see.
- **Firing when `if:` turns true**: misses a new state of an item that still matches, such as a push under review.
