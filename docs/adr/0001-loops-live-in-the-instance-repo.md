# Loops are in the instance repo, not in managed repos

Unlike GitHub Actions files, every loop file is in the instance repo, with the registry and settings, read from the default branch only. Managed repos contain no usine files. A loop applies to every managed repo unless a selector (repo names or registry tags) limits it. Per-repo tailoring is another loop file with a selector, not an override layer.

## Considered options

- **Per-repo `.usine/loops/`**: loops are next to their code, but generic loops (review every PR, start work on ready issues) are copied into each repo, discovery reads N repos, and UI edits need commit access everywhere.
- **Both, with scoping rules** (repo-scoped loops override global ones by name): rejected. Override rules, two discovery paths, and two write paths in v1, for a capability no acceptance loop uses. Repo-local files serve repo contributors, out of scope with one operator.
- **Instance repo only** (chosen): one discovery path, one write path, and read-only access to managed repos.

## Consequences

- The filename is the loop's identity (`review-pr.<ext>` → `review-pr`). Renaming a file replaces the loop with a new one.
- UI edits commit directly to the default branch; git history is the audit trail. A PR editing a loop has no effect until merged.
- Name-based identity allows adding repo-local discovery later.
