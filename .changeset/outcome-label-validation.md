---
"@usine/core": minor
"@usine/config": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

`outcome_labels` entries use the GitHub label name rules and messages: a trimmed name of at most 50 characters. A loop file whose outcome labels differ only in letter case is rejected, because GitHub compares labels without case. A schedule loop that sets `outcome_labels` fails schema validation, because its runs have no item to label. An outcome label that `usine.yaml` doesn't declare under `labels` adds an `UndeclaredOutcomeLabelWarning` to `LoadedInstance.warnings` and logs `Loop outcome label is not a declared GitHub label`. The loop still loads.

`GitHubLabelName` and `canonicalLabelName` are exported from `@usine/core/label`; import them from there instead of `@usine/config/label`. `OutcomeLabels` in `@usine/core/loop`, and the `outcomeLabels` field of `Submission` in `@usine/engine`, now contain `GitHubLabelName` values.

The loop detail page in **Configuration > Loops** lists a loop's outcome labels and warns about undeclared ones. `LoopFileView` in the operator API adds `outcomeLabels` and `undeclaredOutcomeLabels`. The loop form writes `outcome_labels` only when the loop sets at least one label.
