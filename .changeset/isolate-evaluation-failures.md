---
"@usine/orchestrator": patch
---

An `if:` that fails to evaluate on an item no longer stops the repository's poll: the failure affects only that loop and item, and the cursor advances. **Needs you** lists `if:` and prompt failures with their loop and item while they last, and the first poll after a restart evaluates failing items again.
