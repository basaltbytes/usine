---
"@usine/core": minor
"@usine/config": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

`outcome_labels` entries use the GitHub label name rules and messages: a trimmed name of at most 50 characters. A loop file whose outcome labels differ only in letter case is rejected, because GitHub compares labels without case. A schedule loop that sets `outcome_labels` fails schema validation, because its runs have no item to label. An outcome label that `usine.yaml` doesn't declare under `labels` adds an `UndeclaredOutcomeLabelWarning` to `LoadedInstance.warnings` and logs `Loop outcome label is not a declared GitHub label` when the instance folder loads and each time `CurrentInstance` installs a configuration. The loop still loads. `logConfigWarnings` in `@usine/config/instance` logs these warnings.

The SQLite configuration store rewrites stored loops that earlier versions accepted and these rules reject, so the stored configuration keeps loading. When it opens, it removes a schedule loop's outcome labels and each label that repeats an earlier one in a different letter case, records the change as one revision without an actor, and logs each loop. If the upgraded configuration is still invalid, the store leaves the stored loops unchanged and logs a warning with the problems. **Configuration > History** shows a stored agent or loop value that the current rules reject as YAML of its stored fields, through `formatRevisionEntity` in `@usine/config/folder-codec`, instead of failing to load the revision.

`GitHubLabelName` and `canonicalLabelName` are exported from `@usine/core/label`; import them from there instead of `@usine/config/label`. `OutcomeLabels` in `@usine/core/loop`, and the `outcomeLabels` field of `Submission` in `@usine/engine`, now contain `GitHubLabelName` values.

The loop detail page in **Configuration > Loops** lists a loop's outcome labels and warns about undeclared ones. `LoopFileView` in the operator API adds `outcomeLabels` and `undeclaredOutcomeLabels`. The loop form writes `outcome_labels` only when the loop sets at least one label.
