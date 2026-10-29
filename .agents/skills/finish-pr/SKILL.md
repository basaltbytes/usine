---
name: finish-pr
description: Finish an agent PR by resolving the latest findings directly, checking the final diff, running the gate, pushing, and recording the outcome. Use when asked to finish or handle a PR by number; merge only on request.
---

# Finish an agent PR

Own the PR through completion: resolve its latest findings, give the final diff a careful look, and fix any remaining problems yourself in the PR branch. The argument is the PR number.

## Load first

`/thermo-nuclear-code-quality-review`, `/effect-ts`, `/coding-guidelines`. Apply their standards yourself during this finishing pass. Follow AGENTS.md, including its observability and exhaustive-error-handling rules. Read the issue the PR closes and the ADRs it cites.

## Workflow

1. **Establish the current state**: read the PR body, head branch and commit, base branch, latest reviews, unresolved review threads, and the full diff against the fetched base branch. Work in the PR branch's worktree (`git worktree list`). Verify any expected head supplied by the task before editing; if it changed, report the mismatch. Check mergeability; if the PR conflicts, fetch and merge its base and resolve conflicts as described in **Conflict recovery and CI** before inspecting the diff.
2. **Resolve the findings**: check which findings still apply to the current code. Fix actionable findings directly, including new problems found during your final inspection. Verify load-bearing Effect claims against the pinned source before changing code. Record why any finding is already resolved, inapplicable, or declined; a confirmed blocker remains a blocker until fixed.
3. **Inspect the final diff yourself** against the acceptance criteria and repository standards, including how your fixes interact with the rest of the PR. Fix confirmed problems in this same session. Do not split finishing into alternating review-only and fix-only sessions or launch an independent reviewer unless the user explicitly requests one.
4. **Validate behavior**: add regression coverage for meaningful behavior fixes at a public seam. Update tests that encode obsolete behavior to assert the new invariant. Keep tests focused on observable behavior rather than implementation details.
5. **Run the gate from the repo root** (direct package `pnpm test` misses turbo dependency builds): `pnpm check && pnpm test && pnpm format:check && pnpm lint && pnpm knip`. Fix failures within the PR's scope and rerun affected checks; the final tree must pass the required gate. If completion needs a scope decision or unavailable access, report the concrete blocker and current branch state.
6. **Publish the finished result**: follow **Conflict recovery and CI** before pushing and wait for CI on the pushed head. Commit messages end with the `Claude-Session:` trailer. The balade GitHub App regenerates `.agents/walkthroughs/` in CI; never write or refresh those files by hand. Record the outcome on the PR: findings resolved, changes made, checks run, and any unresolved blocker with its reason. Apply any outcome labels specified by the task only after their conditions are met, including successful CI.
7. **Stop at completion**: once the checked final head is pushed, its CI passes, and the outcome is recorded, return the PR link, head commit, changes, and validation result. Do not start another review round to approve your own completed pass. If blocked, return the blocker and any local or pushed commits so work can be recovered.
8. **Merge only when Philippe requests it**, using the repository's authorized merge workflow. Then confirm the PR is merged and main CI is green, and report any integration consequences for active sibling branches.

## Conflict recovery and CI

GitHub does not run `pull_request` workflows for a conflicting PR. Resolve the conflict before waiting for those checks; dispatching a workflow does not repair mergeability.

1. Before pushing, read the live PR with `gh pr view <number> --json headRefOid,baseRefName,mergeable`. If `mergeable` is `UNKNOWN`, wait briefly and query again. Verify that the remote head is still the one you started from; reconcile an unexpected push before publishing.
2. If `mergeable` is `CONFLICTING`, fetch the reported base branch and merge `origin/<baseRefName>` into the PR branch. Use the `resolving-merge-conflicts` skill, preserve the intent of both sides, and resolve conflicts within the issue and findings. A conflict alone is not a blocker. If resolution needs a decision the issue and findings do not cover, post the exact conflict, question, and options on the PR, leave outcome labels unchanged, and return `[usine:question]` as the first line.
3. Run the repository gate on the resolved tree, commit, and push to the PR branch. Watch CI in the foreground until the checks for that pushed head finish successfully. Pending checks are unfinished work.
4. If the pushed head has no checks, query mergeability again: the base may have changed during the fix. For a new conflict, repeat the merge, gate, push, and CI watch. If the PR is mergeable, inspect the workflow triggers and run status; report a blocker only with concrete evidence, not solely an empty checks list. Confirm the PR still has the checked head before recording success or applying outcome labels.

## Gotchas that have bitten before

- Worktree LSP diagnostics are module-resolution noise; `pnpm check` is the only truth.
- Never emit a raw NUL byte into source (e.g. as a key separator) — git flags the file binary. Use a space, or spell the escape out as backslash-u0000 in source; check `git diff --stat` for `Bin` lines before pushing.
- Drizzle migration snapshots are cumulative: if the PR and main both added migrations, regenerate on the merged tree.
- Tightening a brand (e.g. `Repository.Revision`) breaks test fixtures built to violate it — rebuild the fixture inside the brand, don't loosen the brand.
