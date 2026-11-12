---
title: Answer an agent question or blocker
description: Respond on GitHub and release work suppressed by an agent outcome.
---

Resolve an agent’s question or blocker so its loop can act on the item again.

## Prerequisites

A question or blocker in **Needs attention**, access to its GitHub item, and project operator access or a higher role.

## Procedure

1. Open the entry and read the agent’s question or exact blocker. Inspect the linked GitHub comment and failed attempt.
2. Reply on the GitHub item with the decision, or fix the stated blocker. Keep the answer within the item’s requested scope.
3. Select **Mark answered** for a question or **Mark resolved** for a blocker after the decision or fix is ready. Use **Retry** if the existing run should make another attempt with the same task.

## Check the result

The unresolved attention entry clears. Marking the question answered or blocker resolved checks the newest item state; a matching active loop can open work again.

An agent ends with `[usine:question]` or `[usine:blocked]` and records the decision needed on the item. usine also recognizes these reserved markers at the start of a later line, or appended directly to narration at the end of a line, including narration that ends in a closing quote or inline code, so that report still fails the attempt. A marker mentioned within a sentence, directly after an opening quote, or quoted in a fenced code block is ordinary text. An opening quote is a run of one repeated quote character (`"`, `'`, or a backtick) at the start of a line or after whitespace, `(`, or `=`. A closing quote or backtick in that position also counts as opening, so narration that ends in inline code such as `` `FOO=` `` does not report a marker appended to it. That outcome suppresses automatic work for the same state. A later changed item state can release suppression. A GitHub reply must change the item after polling observed the question; if both happen within one poll interval, use the explicit action above.

An answer that starts with `[usine:provider-capacity]` or `[usine:failed]` retains that outcome even when a blocker or question marker appears later. Capacity reports use a delayed retry; failure reports require operator attention without suppressing the item.

A Claude Code, Codex, or Pi session that reaches its subscription or API-key usage limit ends with a capacity report, not a blocker. The retry waits until the limit resets when the harness reports the reset time, and a few minutes when it doesn't. If a child reports a capacity refusal, the attempt ends with that refusal even when the parent reports a blocker or question.

Claude Code, Codex, and Pi child sessions log these reports at Info with `kind` set to `question` or `blocked`, along with the report's `message` and `sessionId`. These reports still end the attempt with a question or blocker. Harness and infrastructure failures log at Error.
