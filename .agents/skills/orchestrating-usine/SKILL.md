---
name: orchestrating-usine
description: Operate a usine instance as its overseer. Use when asked to run, babysit, or supervise the factory, queue issues, approve runs, merge agent PRs, upgrade or tweak the instance, edit loops or agent personas, or resume factory operations from a handoff.
---

# Orchestrating usine

You run a usine instance for a human who reads this thread rarely, maybe never. The instance does the coding; you queue work, approve runs, read every PR diff, merge, keep the server healthy, and file every rough edge as an issue. Nothing you learn or need from the human may be lost between turns, so there is ledger on disk that carries that knowledge. Load `anti-slop-writing` before writing issues, PR text, or the ledger.

## Load first

1. **Discover the instance** with [`discover.md`](discover.md). The result is `.scratchpad/orchestrating-usine/env.sh`, which every script here sources. Redo it when a call fails with a connection error.
2. **Open the ledger** at `.scratchpad/orchestrating-usine/ledger.md`. If it is missing, create it from [`ledger.md`](ledger.md). Read the open items before anything else: they are the human's answers you still owe and the actions still pending.
3. **Read the handoff** if the human points at one, and merge its open items into the ledger.

## Loop

Repeat until the human says stop. Every pass ends with the ledger updated and, when something changed, a report in the format of [`ledger.md`](ledger.md).

1. **Observe.** Run `scripts/overview.sh` from this skill's folder. It prints Needs attention, running attempts, stalled items, open agent PRs with labels and mergeability, failed default-branch workflows, and recent server errors. For a long unattended stretch, arm `scripts/watch.sh` with the Monitor tool. It will print only the changes.
2. **Act on what you can.** Table of first moves; `api.md` has the calls.

   | Signal | Move |
   | --- | --- |
   | Approval needed | Approve if the issue is in the queue the human set (`scripts/approve-runs.sh [--repo owner/name] <issue>...` waits for the entry); otherwise leave it and list it under Decisions. |
   | Run failed | Read the attempt transcript. Retry an infrastructure failure once. Edit and retry when the prompt was wrong. Mark resolved when the item moved on. File an issue for every failure usine should have handled. |
   | Question from the agent | Answer from the issue, the ADRs, and the ledger. If the answer is the human's, put the question under Decisions and leave the run on hold. |
   | Cycle budget used | Read why the rounds failed. Reset only with a reason you can state; otherwise Decisions. |
   | PR `ready-to-merge` | Follow **Merge**. |
   | PR conflicting, no loop on it | Load `resolving-merge-conflicts`, or relabel so the configured recovery loop takes it. |
   | Worker silent, provider unreachable, preflight failed | Check the worker over SSH if `env.sh` has a destination. File an issue; put host-level fixes under Actions. |
   | Upgrade available | Follow **Instance changes**. |
   | Idle slots and an empty Ready lane | Queue the next issues from the order the human gave. Never invent priorities; ask under Decisions. |

3. **Write the ledger**, then report. Keep every open item until the human acts on it or dismisses it.

## Merge

Agent PRs merge through you, one at a time:

1. `gh pr view <n> --json mergeable,statusCheckRollup,labels,headRefOid` and read the fields. A piped `gh pr checks` exit code is not evidence.
2. Confirm no finishing loop has a running attempt on the PR (`scripts/overview.sh` lists running attempts by item). Merging under a finisher wastes its run and can push after the merge.
3. Read the whole source diff: `gh pr diff <n>`. Load `effect-ts` for Effect code and `code-review` for an independent second read of a large or security-sensitive PR. UI changes get screenshots the human sees before the merge: Decisions, not merge.
4. Merge with the repository's merge method. Then watch the default branch's workflows for that commit and retry transient failures once.
5. Record the merge under Done with the issue it closed, and remove the PR from the watchlist.

Never merge a release or version-bump PR; publishing belongs to the human. Never close a PR the human has not decided on.

## Instance changes

- **Loops and agents** live in the configuration store, not in files. Read the entity, change the text, write it back with the latest revision number: `scripts/config-edit.sh <kind> <name>` does the round trip and refuses on a stale revision. A prompt renders when the run is created, so a waiting run keeps the old prompt: cancel it, remove the trigger label for one poll, re-add it.
- **Pause before a risky edit**: pause the loop, edit, resume. New loops start paused.
- **Upgrade**: `GET /api/upgrade` for the state; `POST /api/upgrade` with `{"timing":"idle"}` or `"now"`. Before a release that migrates storage, take a backup with `usine backup` on the host and note the path under Done. After the restart: check the host log for errors, confirm the version with `GET /api/version`, and watch one run finish end to end before the next upgrade.
- **Host access**: `env.sh` names the SSH destination and instance folder when there is one. `usine` may not be on the SSH `PATH`; use the absolute path `discover.md` found. Root changes, credential changes, and anything the permission classifier refuses go to the human as a ready-made script under Actions.

## Scripts for the human

When only the human can act, write a script into `.scratchpad/orchestrating-usine/actions/<slug>.sh` that does the whole step, prints what it did, and is safe to run twice. In the ledger, give the one-line command to run it. Load `wizard` when the step needs more than one command or an unfamiliar dashboard.

## Standing rules

- Read every diff before a merge. Dogfood a server change on the instance before calling it done.
- File an issue for every rough edge, with the attempt id or PR, before moving on. Batch small fixes; never ask whether to file.
- No outward action outside the instance's own repositories without the human's yes.
- Secrets travel over SSH stdin or files with mode 0600, never on a command line or in the ledger.
- Factory agents never dogfood; you do, after the merge. 
