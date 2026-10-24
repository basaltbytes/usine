---
"@usine/orchestrator": minor
"@usine/server": patch
---

Adds `item` to `ApprovalNeed` in `@usine/orchestrator/operator`: the item that the waiting run would work on, or null if no board card shows it.

Restyles the web UI with Catppuccin Mocha, Inter, and JetBrains Mono. **Needs you** shows each approval with its loop and task, and the board lists label lanes first, collapses Unmapped and closed-item lanes, keeps lane headings visible while scrolling, and labels the arrow between two lanes with the loops working in the left one.
