---
"@usine/orchestrator": patch
---

An `if:` that fails to evaluate on an Item no longer stops the repository's poll: the failure applies to that Loop and Item, the other Loops and Items continue, and the cursor advances. `if:` and prompt failures appear in Needs you with the Loop and the Item for as long as they last and are logged once per Loop, Item, and content hash. The first poll after a restart evaluates the failing Items again, so an issue whose prompt failed is no longer skipped until it changes.
