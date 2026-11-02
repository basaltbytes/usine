---
title: Back up instance state
description: Locate runtime files and back up the configuration and run history.
---

Use `usine backup ./backup.sqlite` from the instance folder to back up both stores. See [Back up and export](/guides/operate-runs/#back-up-and-export) for the complete procedure.

## Runtime state

usine writes its state to `.usine/` in the instance folder:

| Path                                          | Contents                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.usine/runtime.sqlite`                       | Events, runs, attempts, transcripts, board projections, poll cursors, and loop pause flags. usine never deletes a row.                                                                                                                                                           |
| `.usine/durable.sqlite`                       | The Pi parent task and conversation of each attempt, which usine resumes after a restart.                                                                                                                                                                                        |
| `.usine/github-app.json`                      | The App credentials, if you use the file.                                                                                                                                                                                                                                        |
| `.usine/instance.lock`, `.usine/instance.pid` | The lock that prevents a second `usine up`, and the process ID of the running one.                                                                                                                                                                                               |
| `.usine/instance.json`                        | The [instance record](/reference/cli/#instance-record) of the running `usine up`.                                                                                                                                                                                  |
| `.usine/instance-id`                          | The instance's ID, which labels its attempt containers on SSH workers.                                                                                                                                                                                                           |
| `.usine/usine.log`                            | The output of an orchestrator that `usine up --detach`, `usine restart`, or `usine upgrade` started.                                                                                                                                                                             |
| `.usine/backups/`                             | The copies of the stores that `usine upgrade` makes before it moves the pin.                                                                                                                                                                                                     |
| `.usine/workers/<worker>/`                    | For a local worker: cached clones in `repos/`, attempt worktrees in `attempts/`, and the Turborepo cache in `turbo/`.                                                                                                                                                            |
| `.usine/known-hosts/`                         | The host key of each machine that a [provisioned worker](/guides/add-a-provisioned-worker/) created, one file per machine.                                                                                                                                                       |
| `.usine/ssh-workers/`                         | How to reach each SSH worker that has a `destination`, one file per worker, without secrets. **Discard leftovers** reads it to remove the attempts' Codex homes from a worker that the stored configuration no longer declares (see [Restarts](/guides/operate-runs/#restarts)). |

The runtime store records every event, so that a loop doesn't act twice on the same item content. Deleting it deletes configuration, revision history, this record, and the run history, so back it up with [`usine backup`](/guides/operate-runs/#back-up-and-export) instead.
