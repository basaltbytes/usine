This page describes commit `c56246f` of basaltbytes/usine as it was on 2026-10-16.

# Storage and configuration

The instance folder is the whole factory: authored files at its top, runtime state in `.usine/`. `usine up` uses its working directory as the instance folder (`apps/server/src/up.ts:107`).

## Files on disk

| Path | Contents | Written by |
| --- | --- | --- |
| `usine.yaml` | Registry, labels, settings, Workers, webhooks mode, operator login | the operator |
| `loops/<name>.md` | One Loop per file | the operator |
| `agents/<name>.md` | One Agent per file | the operator |
| `.usine/runtime.sqlite` | The runtime store: Events, Runs, Attempts, transcripts, projections, cursors | `packages/engine/src/database/local-sqlite.ts:31` |
| `.usine/durable.sqlite` | pi-durable storage: each Attempt's parent task, conversations, documents | `packages/durable/src/storage-path.ts:5` |
| `.usine/instance.lock`, `.usine/instance.pid` | An exclusive SQLite transaction that keeps a second `usine up` out, and the holder's pid | `apps/server/src/instance-lock.ts:44` |
| `.usine/github-app.json` | `app_id` and `private_key`; must be a regular file with mode 0600 | the operator; read by `packages/github/src/local-secrets.ts:42` |
| `.usine/workers/<worker>/repos`, `attempts`, `turbo` | Local Worker caches, worktrees, Turbo cache | `packages/executor/src/local/local.ts:103` |
| OS temp `usine-credentials-*` | One local Attempt's token and gh configuration, removed with the Attempt | `packages/executor/src/local/credentials.ts:22` |
| `<root>/workers/<worker>/repos`, `attempts`, `credentials`, `gh` on an SSH Worker | Caches, worktrees, token files (no Gateway), gh configuration (Gateway) | `packages/executor/src/ssh/` |

The environment variables `USINE_GITHUB_APP_ID` and `USINE_GITHUB_PRIVATE_KEY` take precedence over the secrets file field by field, and the file is not read when both are set (`local-secrets.ts:69`). `usine up` refuses an instance folder under `/tmp`, `/private/tmp`, `/var/folders`, or `$TMPDIR` unless `--allow-volatile-instance` is given (`apps/server/src/cli.ts:214`).

## The runtime store

The engine uses Drizzle ORM 1.0.0-rc.4 over `@effect/sql-sqlite-node` ([ADR 0020](../adr/0020-drizzle-portable-sqlite-projection.md)). The schema is `packages/engine/src/database/schema.ts`. Sixteen generated migrations are in `packages/engine/drizzle/` and run at startup into the table `usine_migrations`, with foreign keys turned off during the run (`local-sqlite.ts:55`). JSON columns have `json_valid` checks, and Effect Schema decodes every row at the boundary (`packages/engine/src/store/codec.ts`). No code deletes a row ([ADR 0010](../adr/0010-single-sqlite-runtime-store.md)): Events, Runs, Attempts, and transcript rows are kept, and states, outcomes, projections, and cursors are updated in place.

| Table | One row is | Line |
| --- | --- | --- |
| `usine_events` | an Event: id, unique dedup key, payload JSON, receipt time | `schema.ts:26` |
| `usine_trigger_events` | the trigger fields of an Event: Item key, Loop, Step, approval, cycle limit and generation, repository, revision, rendered task, Agent JSON, parent model | `schema.ts:37` |
| `usine_item_cycle_budgets` | an Item's budget generation, its open Ask as JSON, and whether a reset waits for a fresh poll | `schema.ts:72` |
| `usine_cycle_reservations` | a Run's reservation in a Loop's budget for one generation | `schema.ts:90` |
| `usine_cycle_resets` | an operator's reset answer, one per Ask | `schema.ts:110` |
| `usine_runs` | a Run: state JSON, resolved failure, open time, and the effective context that edit-and-retry amends | `schema.ts:123` |
| `usine_steps` | the Step of a Run and its result JSON | `schema.ts:150` |
| `usine_attempts` | an Attempt: Worker, number, brain, task, Agent, parent model, intervention flag, outcome JSON, salvage JSON. A partial unique index allows one Attempt without outcome per Run | `schema.ts:169` |
| `usine_attempt_transcripts` | one envelope, with direction and channel sequence, unique per Attempt, direction, and sequence | `schema.ts:204` |
| `usine_approvals` | the approval Event of a Run | `schema.ts:233` |
| `usine_ignored_events` | an Event that can no longer open a Run: `superseded` or `revoked` | `schema.ts:245` |
| `usine_cursors` | a cursor value by key; today only `github-poll:<repository>` (`packages/orchestrator/src/polling/polling.ts:94`) | `schema.ts:260` |
| `usine_item_projections` | the latest payload and content hash of each Item, for the Board | `schema.ts:270` |
| `usine_repository_label_projections` | the latest label catalog of each repository | `schema.ts:289` |
| `usine_loop_runtime` | a Loop's paused flag | `schema.ts:304` |
| `usine_projection_revision` | a single row whose revision invalidates cached operator projections | `schema.ts:310` |

`usine_attempts` has no usage column. Token counts and rate-limit windows exist only as transcript envelopes, and the drawer computes its meters from them (`apps/web/src/run-drawer.tsx`, `poolMeters`).

The services over these tables are assembled by `layerWithDatabase` (`packages/engine/src/engine/engine.ts:268`): `RunStore`, `RunReader`, `CursorStore`, `CycleBudgets`, the two projection readers and writers, and `LoopControl`. `observationLayer` (`local-sqlite.ts:91`) opens the same file without recovering Runs, for setup mode. `runReaderLayer` (`local-sqlite.ts:139`) opens it read-only for `usine export-run`.

`usine backup <path>` copies `durable.sqlite` first, then `runtime.sqlite`, each with SQLite's backup API and a hard link into place, so a copy never overwrites an existing file (`apps/server/src/backup.ts:19`). A path `backup.sqlite` gives `backup.durable.sqlite` beside it.

## The durable storage

pi-durable opens `.usine/durable.sqlite` through its own connection and owns its format (`packages/durable/src/live.ts:47`). usine writes two documents there per Attempt (`packages/durable/src/attempt/documents.ts`). `AttemptRecordDoc` has the task id, the parent model and conversation, the child spawn count, the first child blocker, the next outbound and inbound sequences, the relay position, whether the terminal envelope was relayed, and the harvested result. `HoldDoc` has whether the parent is paused, operator guidance waiting for it, and the held children. The table layout inside the file is pi-durable's and is not documented here.

## `usine.yaml`

`UsineConfig` (`packages/config/src/factory.ts:209`) decodes the file with `onExcessProperty: "error"` (`packages/config/src/parser.ts:185`). An invalid file stops `usine up` with a `FactoryConfigError`.

| Key | Contents | Default |
| --- | --- | --- |
| `version` | `1` | required |
| `labels` | labels to create in every managed repository: `name`, optional `color`, `description` | `[]` |
| `repos` | `name` (`owner/name`), `tags`, `lanes` (`name`, `sources`: `{ label }` or `{ state: issue-open, issue-closed, pr-open, pr-closed, pr-merged }`) | required |
| `settings.poll_interval` | seconds between poll cycles | 60 |
| `settings.max_children` | child sessions per Attempt, sequential spawns included | 4 |
| `settings.max_attempt_minutes` | wall-clock ceiling, also the drain deadline | none |
| `settings.max_attempt_tokens` | token ceiling across parent and children | none |
| `settings.parent_model` | Pi parent model when the Agent has none | none: Pi's default |
| `settings.parent_effort` | parent effort when the Agent has none | the child brain's effort |
| `workers` | see [`workers-and-gateway.md`](workers-and-gateway.md) | one `local` Worker |
| `webhooks.mode` | `off`, `deliveries`, or `endpoint` with `public_url` | `off` |
| `operator` | the operator's GitHub login, used to attribute interventions | none: `local operator` |

The webhooks setting is parsed and no code reads it (#37). The parent model is resolved when the Event is submitted and stored with it (`packages/orchestrator/src/trigger-submission.ts:53`), while the parent effort is resolved from the settings at each Attempt (`packages/orchestrator/src/scheduler.ts:185`).

## Loop files

`loops/<name>.md`, kebab-case. `parseLoopFile` (`parser.ts:215`) splits the YAML frontmatter from the Markdown body (`packages/config/src/frontmatter.ts:24`), parses YAML with unique keys and strict mode (`packages/config/src/yaml/document.ts:18`), decodes the frontmatter, then type-checks `if:` as a boolean and each `{{ }}` interpolation as a scalar.

| Frontmatter key | Values | Default |
| --- | --- | --- |
| `trigger.on` | `issue`, `pr`, `schedule` | required |
| `trigger.if` | CEL boolean over `item` and `repo` | required, also for `schedule` |
| `trigger.cron`, `trigger.tz` | five-field cron and IANA zone, `schedule` only | `tz: UTC` |
| `selector` | `repos` and/or `tags`; both must match when both are present | every repository |
| `approval` | `none`, `required` | `none` |
| `step` | Step name | `run` |
| `agent` | an Agent file name | required |
| `max_cycles` | Runs per Item between resets | 3 |

The CEL engine is `@marcbachmann/cel-js` 8.0.0 behind `ExpressionEngine` (`packages/expression/src/expression-engine.ts:89`). The environment has two variables (`packages/config/src/payload-slices.ts:173`): `repo` with `name`, `owner`, `url`, and `item`, typed as `IssuePayload`, `PullRequestPayload`, or `SchedulePayload`. The payload slices follow GitHub's GraphQL names, with fixed connection sizes such as `labels(first: 50)`, `comments(last: 20)`, `reviews(last: 20)`, and `reviewThreads(first: 50)` (`packages/github/src/polling/queries.ts`).

`InstanceFolder.load` (`packages/config/src/instance-folder.ts:93`) quarantines a Loop that fails to parse or references an unknown Agent, repository, or tag, and loads its siblings. It logs a warning for a label used in a lane or an `if:` that `labels` does not declare (`parser.ts:256`).

## Agent files

`agents/<name>.md`, kebab-case. The frontmatter has `harness` (`claude`, `codex`, `pi`), `model`, `effort` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), and optional `parent_model` and `parent_effort`. The body is the persona (`parser.ts:191`). An Agent file that fails to parse is left out of the roster, and every Loop that uses it is quarantined.

## Key renaming at the boundary

Authored keys are snake_case and domain fields camelCase. The rename is `Schema.encodeKeys` in `SettingsFromYaml` (`factory.ts:182`), `WorkerFromYaml` (`factory.ts:193`), the Worker `gateway` (`factory.ts:140`), the `endpoint` webhooks mode (`factory.ts:173`), and the Loop frontmatter's `max_cycles` (`parser.ts:40`). `AgentFrontmatter` is the exception: it declares `parent_model` and `parent_effort` as snake_case fields and copies them into `AgentFile` by hand (`parser.ts:44`, `:203`).

## When configuration is read

`usine up` loads the instance once at start (`up.ts:114`). Nothing watches the files, so an edit takes effect after a restart. `packages/config/src/yaml/writer.ts` has `updateYaml` and `updateFrontmatter`, which change one path and keep comments and key order; only tests call them, and the UI has no configuration editor (#40).
