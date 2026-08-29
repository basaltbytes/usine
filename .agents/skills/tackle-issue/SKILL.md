---
name: tackle-issue
description: Take a GitHub issue (or an open PR) from spec to a shipped PR at the usine standard — precedent study, self-review lens, changesets, walkthrough.
disable-model-invocation: true
argument-hint: <issue-or-pr number> [notes]
---

# Tackle an issue

Turn one GitHub issue into one shippable PR. Every package here is a precedent: later agents copy what this PR does, so the standard is set now, in this PR — never deferred.

## 1. Load the context

- Load the `coding-guidelines` and `effect-ts` skills before touching code. The AGENTS.md standing rules apply in full.
- Read the issue, its comments (renames and scope notes hide there), and every ADR and CONTEXT.md section it links.
- Study the precedent packages before writing anything: `packages/engine` and `packages/config` are the reference implementations for package layout, services, errors, and seams.

Done when you can restate the issue's acceptance criteria and name which precedent each part of the work will mirror.

## 2. Stage the branch

- Run `git worktree list` first. The branch may be checked out in another worktree (codex sessions keep theirs); leave other worktrees alone and work in a temporary worktree, pushing to the branch.
- Fresh issue: branch from `origin/main`. Existing PR: rebase its branch onto `origin/main`, resolve conflicts, and fix all fallout from rules main adopted since the branch diverged.
- The local gate is the CI sequence in `.github/workflows/ci.yml`, run locally.

Done when the gate is green at the starting point, before any new work.

## 3. Build

- Decomposed commits, each individually green. Preparatory refactoring lands in its own commit, apart from the behavior change.
- Where the issue needs a pattern the precedents don't carry, establish it with the same deliberateness — and record it: a standing rule goes in AGENTS.md, an architectural decision becomes an ADR.
- When an Effect API shape is in doubt, the pinned source mirror wins (see the effect-ts skill's Version Pin). When a construct is unproven, prove it in a throwaway `node --input-type=module` probe before building on it.

## 4. Review your own diff

Walk every file of the diff against each axis. A finding is a change request to yourself: it lands in this PR.

- **Structure** — files that belong together move into folders; shared name prefixes become folders, prefix dropped.
- **Domain integrity** — charter §1: branded ids and value objects; parse, don't validate — raw input becomes domain types through Schema at the boundary and nothing revalidates past it; domain schemas reject unknown keys; discriminated unions instead of status fields with optionals; aggregates enforce their own cross-field invariants at construction; rejection tests prove invalid values are unconstructible.
- **Services** — `Context.Service` with the interface declared on the tag (a public API inferred from the implementation is a finding); tags namespaced `@usine/<package>/...`; methods keep `R = never`; `Effect.fn` named spans on every method.
- **Errors** — one exported failure union per package; error class name equals its tag; library and vendor errors translated at the seam so foreign shapes never cross into domain code; defects reserved for violated invariants.
- **Platform seams** — package root entries stay platform-free: prove it by walking the built `dist` import graph for `node:*`; Node-only composition goes behind a subpath export; platform services stay in layer requirements.
- **Literal sets** — each set written once, with a compile-checked owner; a set restated across packages moves to the shared owner (usually `@usine/core`).
- **Tests** — real seams only: fixtures flow through the real parsers, live tmp directories, zero module mocks; every test names the regression it catches; dead and tombstone tests are deleted.
- **Spec** — re-read the issue and confirm every acceptance criterion against the final diff.
- **Consistency** — divergence from a sibling package is itself a finding: align it, or write down why it stays.

Done when every axis has been walked over every changed file and no finding remains open.

## 5. Finish the surface

- Update the README of every touched package.
- Add changesets for every package whose published surface changed — siblings included.
- Write the PR body through the `public-facing-copy` skill: what the change does for users, no process narration.

## 6. Ship

- Gate green locally, push, confirm CI green on the PR.
- Generate the walkthrough: `npx balade generate <PR>`, validate with `npx balade check`, commit it under `.agents/walkthroughs/` stamped at the head it documents. A caution the generator raises is a review finding — fix it in the PR, restamp the walkthrough at the new head, and push again.

Done when CI is green on the final head and the walkthrough's stamped commit matches it.
