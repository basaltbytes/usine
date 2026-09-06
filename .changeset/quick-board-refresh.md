---
"@usine/github": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Refresh Board moves from GitHub promptly and evaluate their Loops without waiting for the next periodic poll. Coalesce self-write Hints, preserve normal polling and Event deduplication, and honor GitHub request backoff.

Keep moved cards in their destination through stale refreshes and project navigation, show saving and synchronization progress, and keep every Board lane reachable beside the sidebar.
