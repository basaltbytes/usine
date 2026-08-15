# Loops live in the instance repo, not in managed repos

GitHub Actions has trained everyone to expect automation files inside the repo they act on, and usine deliberately diverges: every loop file lives in the single operator-owned instance repo (alongside the registry and factory settings), read from its default branch only, and managed repos carry no usine files at all. A loop applies to every registered repo unless a selector (repo names or registry tags) narrows it; per-repo tailoring is another loop file targeting that repo, never an override layer.

## Considered Options

- **Per-repo `.usine/loops/`** — loops sit with the code they act on, but the factory's generic loops (review every PR, start dev on ready issues) get copied into every managed repo, discovery fans out to N repos, and the UI round-trip needs commit access everywhere.
- **Both, with scoping rules** (global + repo-scoped overriding by name) — explored in depth, rejected: override algebra, two discovery paths, and two write paths, all paid in v1 for a capability none of the acceptance loops uses. The audience repo-local files serve — repo contributors — is out of scope (single operator).
- **Instance repo only** (chosen) — one discovery path, one write path, read-only access to managed repos suffices for configuration.

## Consequences

- Loop identity is the filename (`review-pr.<ext>` → `review-pr`); renaming a file retires one loop and creates another.
- UI edits commit directly to the instance repo's default branch — git history is the audit trail; a PR editing a loop changes nothing until merged.
- Repo-scoped loop files are not precluded: name-keyed identity would let a repo-local discovery source be added later as an additive layer.
