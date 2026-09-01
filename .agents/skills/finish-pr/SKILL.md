---
name: finish-pr
description: Senior-dev finishing pass on a Codex agent PR — deep review, apply the fixes in the PR branch, gate, push, record the review, merge on request. Use when asked to review/finish/handle a PR by number.
---

# Finish a Codex PR

You are the finishing senior dev on a PR a Codex agent opened. Review hard, then **you** land the fixes on the PR branch. The argument is the PR number.

## Load first

`/thermo-nuclear-code-quality-review`, `/effect-ts`, `/coding-guidelines`. AGENTS.md is law — especially the observability/exhaustive-error-handling standing rule. Read the issue the PR closes (its acceptance criteria) and the ADRs it cites.

## Workflow

1. **Gather**: `gh pr view N` (files, body, head branch), the full diff vs `origin/main`, branch state (must contain main — if not, merge main in first). The branch is usually checked out in a Codex worktree (`git worktree list`); do all edits there.
2. **Dispatch one Opus deep-review subagent** with: worktree path, diff, acceptance criteria, ADR paths, the AGENTS.md standing rule, and the review dimensions that fit the surface (contract fidelity, credential hygiene, interruptibility/bounds, observability, structure/code-judo, type boundaries, test gaps). Require it to verify every Effect API against the pinned source in `node_modules/.pnpm/effect@<pinned>*` and to verify each claim against file contents before reporting. Report-only; severity-ranked.
3. **Meanwhile**: run the full gate in the worktree and read the core new files yourself. Don't idle on the subagent.
4. **Triage**: independently re-verify any load-bearing claim against the pinned Effect source before acting on it. Fix blockers, majors, and cheap minors yourself; decline the rest **with recorded rationale** (rebase collisions with in-flight sibling branches are a valid reason to defer structural moves).
5. **Behavior changes get tests**: every blocker fix ships a regression test; tests asserting the old behavior get rewritten to assert the new invariant, not deleted.
6. **Gate from the repo root** (direct package `pnpm test` misses turbo dep builds): `pnpm check && pnpm test && pnpm format:check && pnpm lint && pnpm knip`.
7. **Commit and push** to the PR branch. Commit messages end with the `Claude-Session:` trailer. The balade GitHub App regenerates `.agents/walkthroughs/` in CI; never write or refresh those files by hand. Then post a **review-record PR comment**: what was found and fixed, what was declined and why, what is deferred and where it's carried.
8. **Merge only when Philippe says so.** `gh pr merge` is blocked by the permission classifier — use `git merge --no-ff origin/<branch> -m "Merge pull request #N from basaltbytes/<branch>"` + `git push origin main`, then confirm the PR shows MERGED and main CI is green.
9. **Close out**: report rebase implications for still-running sibling agent branches; offer a paste-ready prompt for them if surfaces moved.

## Gotchas that have bitten before

- Worktree LSP diagnostics are module-resolution noise; `pnpm check` is the only truth.
- Never emit a raw NUL byte into source (e.g. as a key separator) — git flags the file binary. Use a space, or spell the escape out as backslash-u0000 in source; check `git diff --stat` for `Bin` lines before pushing.
- Drizzle migration snapshots are cumulative: if the PR and main both added migrations, regenerate on the merged tree.
- Tightening a brand (e.g. `Repository.Revision`) breaks test fixtures built to violate it — rebuild the fixture inside the brand, don't loosen the brand.
