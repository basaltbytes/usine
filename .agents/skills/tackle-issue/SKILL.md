---
name: tackle-issue
description: Take a GitHub issue or an open PR to a shipped PR at the usine standard.
disable-model-invocation: true
argument-hint: <issue-or-pr number> [notes]
---

# Tackle an issue

1. **Context** — load `coding-guidelines` and `effect-ts`. Read the issue with its comments and
   every ADR and CONTEXT.md section it links; study the precedent packages (`packages/engine`,
   `packages/config`) before writing anything.

2. **Branch** — `git worktree list` first: the branch may be checked out in another session's
   worktree — leave those alone, work in a temporary worktree pushed to the branch. Fresh work
   branches from `origin/main`; an existing PR rebases onto it. The gate is
   `.github/workflows/ci.yml` run locally — green before any new work.

3. **Build** — decomposed, individually green commits. A pattern the precedents don't carry is
   established deliberately and recorded: AGENTS.md for a standing rule, an ADR for an
   architecture decision. Prove an unfamiliar Effect construct in a throwaway node probe before
   building on it.

4. **Review your own diff** — walk every changed file against the loaded charter and `effect-ts`
   rules, then run the `thermo-nuclear-code-quality-review` skill over the branch diff. Beyond
   those: prove root entries platform-free by walking the built `dist` import graph; a literal
   set restated across packages moves to its shared owner (usually `@usine/core`); divergence
   from a sibling package is aligned or written down; every acceptance criterion re-confirmed
   against the final diff.

5. **Surface** — README per touched package; changesets for every package whose published
   surface changed, siblings included; PR body through `public-facing-copy`.

6. **Ship** — gate green, push, CI green on the PR. The balade GitHub App generates
   `.agents/walkthroughs/` in CI; never write or refresh those files by hand.
