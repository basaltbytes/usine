---
"@usine/orchestrator": minor
"@usine/server": patch
---

`ApprovalNeed` in `@usine/orchestrator/operator` carries `item`, the Item the waiting Run would work on as its Board card shows it, or null when no card holds it.

The web UI follows the category standard on Catppuccin Mocha with Inter and JetBrains Mono. Needs you lists its entries in two columns with their actions inline, and an approval names its Loop and its Task. The Board puts authored label lanes first, folds Unmapped and closed-Item lanes into rails until opened, keeps lane headings in view while cards scroll, and draws an arrow between authored lanes that names the Loops at work in the left one.
