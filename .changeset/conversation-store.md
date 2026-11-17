---
"@usine/core": minor
"@usine/orchestrator": minor
---

`@usine/core/conversation` models conversations with the supervisor: a conversation with a scope and an optional anchor, member and supervisor messages, and turns with the states `Queued`, `Running`, `Succeeded`, `Failed`, and `Canceled`. Each transition accepts only a turn in its legal source state. An anchor's kind and reference are opaque strings, and its key is the SHA-256 of both. A turn stores its authority: the posting credential's grants within the conversation's scope, and its operation ceiling.

`@usine/orchestrator/conversation/store` declares the `ConversationStore` port, with a memory adapter and a SQLite adapter on the runtime database. The SQLite adapter keeps its own `usine_conversation_migrations` ledger.
