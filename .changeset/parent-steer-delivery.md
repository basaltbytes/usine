---
"@usine/core": patch
"@usine/durable": patch
"@usine/engine": patch
"@usine/executor": patch
"@usine/server": patch
---

Forward parent steers to the single live child and record the receiving child in delivery receipts. Require a separate parent turn when a steer cannot be delivered, including after a restart. Withdraw unread guidance on interruption and keep the parent paused until new guidance or release. Show forwarding, parent delivery, and unread steers in the run transcript.
