---
"@usine/agents": patch
"@usine/core": patch
"@usine/config": patch
"@usine/executor": patch
"@usine/orchestrator": patch
---

Require container seats for supervisor sessions and enforce configurable CPU, memory, process, temporary storage and persistent conversation limits. Conversation storage on Docker and Podman requires Linux FUSE and a preallocated ext4 filesystem. Bound relay requests and Pi file reads, restrict model forwarding, and remove labeled containers at turn end, shutdown and startup before reopening a conversation.
