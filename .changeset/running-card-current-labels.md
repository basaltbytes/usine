---
"@usine/orchestrator": patch
"@usine/server": patch
---

The Board places a running card by its Item's current labels first. While a Task's newest open Run is `Running` and its current Item is open, the card goes to the first label lane that matches the Item's current labels, so a card moves to In progress as soon as `start-dev` swaps `ready-for-agent` for `agent-in-progress`. The card stays in the lane its Run's trigger matched, read from the Run's Event, only if the current labels match no label lane, for example after a Loop removes its trigger label and sets no other. The Task page names the same lane, and a Board move records the lane the card showed in.
