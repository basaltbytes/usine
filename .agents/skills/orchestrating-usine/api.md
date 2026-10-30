# Operator API

`scripts/usine-api.sh <METHOD> <path> [json-body]` adds the base URL and the token. The architecture page `apps/docs/src/content/docs/architecture/operator-surfaces.mdx` in the usine repository documents every field; the router in `packages/orchestrator/src/operator/http.ts` is the source of truth when the two disagree.

## Read

| Call | Gives |
| --- | --- |
| `GET /api/version` | Running server version. Also the auth probe. |
| `GET /api/overview` | `needsYou` (each entry has `_tag`, `runId`, `item`), projects with runs and board, loops with `paused`. |
| `GET /api/desk` | Attempts in flight, stalled items with reason, last 10 closed runs, worker slots and preflights, poll times. |
| `GET /api/runs/<runId>` | Run, attempts, and the newest 500 transcript rows per attempt. `?after=<seq>` pages forward. |
| `GET /api/runs/<runId>/github-changes` | Comments, labels, and reviews the run posted. |
| `GET /api/projects/<owner>/<repo>/tasks/<item>` | The task around an issue or PR number: items, runs, posted comments. |
| `GET /api/statistics?window=7d` | Tasks done, time per task, first time right. `/api/statistics/runs` for per-loop and per-agent figures. |
| `GET /api/configuration` | Loops, agents, workers, repositories, labels, settings, quarantined entities with errors. |
| `GET /api/configuration/revisions` | Revision log. `/revisions/<n>` for one. |
| `GET /api/configuration/entities/<kind>/<name>` | `text` and `number`, the revision it was read at. Kinds: `loop`, `agent`, `worker`, `repository`, `label`, `settings` (name `instance`). |
| `GET /api/upgrade` | `running`, `channel`, `mode`, `available` (null when none), `phase`: `idle`, `waiting`, `installing`, `failed`, `message`, last `outcome`. |

## Act on runs

| Call | Body | Note |
| --- | --- | --- |
| `POST /api/runs/<id>/approve` | `{}` | 409 unless `Waiting`. |
| `POST /api/runs/<id>/retry` | `{}` | New attempt, same prompt. |
| `POST /api/runs/<id>/edit-and-retry` | `{"task":"...","agent":"<name>"}` | New prompt or agent. |
| `POST /api/runs/<id>/run-again` | `{"task":"...","agent":"<name>"}` | New run on a closed one; `CycleBlocked` when the budget is used. |
| `POST /api/runs/<id>/cancel` | `{}` | Salvages the worktree. |
| `POST /api/runs/<id>/resolve-failure` | `{"attemptId":"<runId>/<step>/<n>"}` | Clears the Needs entry. |
| `POST /api/runs/<id>/intervene` | `{"attemptId":"...","target":"parent","action":{"_tag":"OperatorMessage","text":"..."}}` | Also `Steer`, `Interrupt`, `Release`. A message holds the parent; send `Release` after it answers or the attempt never ends. |
| `POST /api/cycle-budgets/reset` | `{"askId":"..."}` | `ask.id` of the `CycleBudgetNeed` entry. |
| `POST /api/attention/dismiss` | `{"id":"<need id>","revision":<n>}` | Hides a Needs entry; `/undo` with the same body brings it back. |
| `POST /api/loops/<loop>/pause`, `/unpause` | none | |
| `POST /api/projects/<o>/<r>/items/<n>/lane` | `{"toLane":"<lane>"}` | Label swap on GitHub; use when `gh` label edits are refused. |
| `POST /api/workers/<name>/discard-leftovers` | none | Only for an undeclared worker with no running attempt. |

## Edit configuration

```sh
scripts/config-edit.sh loop review-pr            # opens the text in $EDITOR, writes it back with the current revision
scripts/config-edit.sh agent developer --file new-persona.md --message "raise effort"
```

Under the hood: `PUT /api/configuration/entities/<kind>/<name>` with `{"expected": <latest revision number>, "message": "...", "text": "..."}`. 409 `StaleRevision` means someone saved first; read again. 422 lists problems with field paths. `POST /api/configuration/loops/check` validates a loop draft and `/preview` renders its prompt; the web editor uses both, read their payload schemas in `packages/orchestrator/src/operator/configuration/` before calling them.

On the host, the same store answers to `usine config export <folder>`, `usine config import <folder> --message "..."`, and `usine config log`. Files in the instance folder are an import and export format; editing them changes nothing until an import.

## Upgrade

```sh
scripts/usine-api.sh GET /api/upgrade
scripts/usine-api.sh POST /api/upgrade '{"timing":"idle"}'                      # waits for running attempts
scripts/usine-api.sh POST /api/upgrade '{"timing":"now","version":"0.4.1-next.271"}'
```

`idle` stops admitting attempts and installs when the last one ends. The helper on a systemd host rolls back a version whose API does not answer within three minutes, but never a storage migration: take `usine backup <path>` first. `ssh $USINE_SSH journalctl -u usine-upgrade.service -n 50` shows the helper's log, `journalctl -u usine.service --since -10m` the server's.

## Transcript queries

The runtime store is SQLite on the host, readable while the server runs:

```sh
ssh $USINE_SSH "cd $USINE_DIR && sqlite3 -readonly .usine/runtime.sqlite \"select sent_at, envelope from usine_attempt_transcripts where envelope like '%PoolRateLimitsUpdated%' order by rowid desc limit 1\""
```

`PoolRateLimitsUpdated` carries the harness plan's `usedPercent` and `resetsAt`; check it before queuing a large batch on a subscription plan.
