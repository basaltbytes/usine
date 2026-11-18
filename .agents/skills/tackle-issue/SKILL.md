---
name: tackle-issue
description: Take a GitHub issue or an open PR to a pushed, reviewable PR.
disable-model-invocation: true
argument-hint: <issue-or-pr number> [notes]
---

# Tackle an issue

A review step checks the pushed diff against the coding standards and for code quality. This skill covers building the change and making it reviewable.

1. **Context.** Read the issue with every comment, and each ADR and `CONTEXT.md` term it links. Find the precedent: the package that already does the nearest thing. This step is done when you can list the acceptance criteria and name the precedent for each module you plan to add.

2. **Branch.** Run `git worktree list`. A branch that is checked out in another session's worktree stays there: work in a temporary worktree and push to the branch. New work branches from `origin/main`; an existing PR rebases onto it.

3. **Build.** Decomposed commits, each one a reviewable step. While you work, run only the test files that cover the change. When no precedent has the pattern you need, record the one you set: `AGENTS.md` for a standing rule, an ADR for an architecture decision. Prove an unfamiliar Effect construct in a throwaway `node` probe before you build on it.

4. **Confirm** against the final diff:
   - Every acceptance criterion is met.
   - Root entries are platform-free: walk the built `dist` import graph.
   - A literal set that two packages repeat is in its owner, usually `@usine/core`.
   - A divergence from a sibling package is aligned or written down.

5. **Surface.** A README for each touched package. A changeset for each package whose published surface changed, siblings included. The docs page that `AGENTS.md` "Writing" requires for each behaviour visible to users. The PR body through `public-facing-copy`.

6. **Ship.** Run the local checks in `AGENTS.md` "Checks", push, and open the PR. CI runs the full suite. Then follow the task's CI instruction; with none, wait until CI passes on the pushed head.
