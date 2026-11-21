---
"@usine/config": minor
"@usine/core": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

A loop can declare the labels to change when CI passes, in `ci.on_green`. Each entry has an integer CEL `item` expression and `add` and `remove` label lists. The expression reads the trigger's `item` and `repo` and `pullRequest.number`, the pull request whose CI passed, so one loop can label the pull request and its issue:

```yaml
ci:
  fix_loop: widgets/act-on-findings
  timeout_seconds: 1800
  on_green:
    - item: pullRequest.number
      add: [ready-for-review]
    - item: item.number
      remove: [agent-in-progress]
```

usine applies these changes whether or not the agent ended with the `[usine:awaiting-ci]` handoff. When the handoff also names `on_green` changes, usine applies the handoff's first and then the loop's, and applies a change that repeats an earlier one only once. A CI fix inherits both. usine reads `on_green` from the loop's current configuration when CI settles. Loops stored without `on_green` load without it. When the loop declares labels, the generated CI handoff instructions tell the agent that the handoff's `on_green` can be empty.

When CI passes on an open pull request, neither the handoff nor the loop names a label change, and the loop doesn't set `on_green`, the run no longer closes as succeeded. The attempt and run fail with `AgentFailure` in **Needs attention**, with a message that names the pull request, which has no completion labels. The same happens when an `on_green` item expression fails. The log line `CI passed; completion actions applied` states how many changes usine applied.

A loop with a CI policy that applies no completion labels when CI passes must now add `on_green: []` to its `ci` settings. Without it, every green run of the loop on an open pull request whose handoff names no labels fails in **Needs attention**. With `on_green: []`, the run succeeds and usine applies only the handoff's label changes, if any.

Breaking API changes:

- `LoopFile.ci` is a `LoopCiPolicy`, which adds `onGreen` to the `CiPolicy` fields: `None` without the key, and `Some` with the declared changes. `loopCiPolicy(loop)` returns the `CiPolicy` that a trigger event records.
- `CiResolution` has a `CiPassedWithoutLabels` variant.
- `CiMonitor.applyLabelsAfterGreen` takes the loaded instance as its first argument and can fail with `CiLabelExpressionError`, which `POST /api/runs/{runId}/apply-ci-labels` returns with status 422.
