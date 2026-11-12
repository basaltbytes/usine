---
"@usine/durable": minor
---

`@usine/durable/coordinator/journal` adds `AttemptJournal`, the store of the event-driven coordinator, with a memory adapter in `/coordinator/memory` and a SQLite adapter in `/coordinator/sqlite`. The journal keeps each attempt's stored request, an event ledger with the first decision recorded for each event, the coordinator state, the delegations it decided, and an outbox of channel envelopes. A transition commits all of them in one transaction and fails with `StaleRevision` when its expected revision isn't current. The SQLite adapter runs on the application's `SqlClient` with its own `usine_attempt_journal_migrations` ledger. No attempt runs on the journal yet.
