---
walkthrough: 1
title: Schedule ticks from cron boundary to Run
pr: 53
commit: 0602de5107a18823a5124dc9a93ad34b6f4ddda2
meta:
  pr: "#53"
  commit: 0602de5107a1
  scope: schedule trigger stream
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="Schedule ticks join the trigger pipeline" icon="clock" %}
This change adds the public `ScheduleTriggers` service. An embedder can call `tick(instance)` for one evaluation or `run(instance)` for a clock-driven loop. Each schedule loop selects managed repos, evaluates its CEL expression against a Tick payload, and submits one Event per selected repo through the existing `RunEngine`.

The main review points are the time calculation and the two identities:

- The Tick uses the latest cron minute at or before the current time. This gives one catch-up Tick after downtime, not a replay of all missed minutes.
- The Event key uses the loop, canonical repo, and scheduled time. Repeated evaluations of the same Tick reach the durable dedup path.
- The Item key uses the canonical repo. Later Ticks for the same loop and repo therefore use the existing supersede and queue rules.

The polling stream now uses the same `triggerSubmission` constructor. This keeps schedule, issue, and pull-request Events on one Event-to-Run route.
{% /section %}
{% /group %}

{% group label="Schedule tick stream" %}
{% section id="tick-boundaries" title="Latest due Tick and next wake-up" icon="history" related=["tick-fanout"] %}
`watchedSchedules` keeps only `on: schedule` loops, applies each loop selector, and parses the already validated cron expression with its IANA time zone. For each schedule, `latestScheduledAt` first removes seconds and milliseconds. It includes the current minute when that minute matches; otherwise it asks Effect Cron for the previous occurrence.

This calculation does not iterate over missed occurrences. One evaluation always produces at most one due time per schedule, which implements latest-missed catch-up.

```pseudo
for each schedule loop
  select managed repos
  normalize now to a minute
  if that minute matches cron
    due = that minute
  else
    due = previous cron minute
  create one candidate per selected repo
```

The same module calculates each schedule's next strict occurrence. `run` performs a cycle immediately, chooses the earliest next occurrence, and sleeps until that boundary. With no schedules, it checks again after one minute.

{% code file="packages/orchestrator/src/schedule-triggers.ts" from=67 to=123 expect="const watchedSchedules = (instance: LoadedInstance): ReadonlyArray<WatchedSchedule> =>" /%}

{% code file="packages/orchestrator/src/schedule-triggers.ts" from=254 to=278 expect="      // No Effect.fn here: `run` never returns, so a named wrapper would open" /%}
{% /section %}

{% section id="tick-fanout" title="Repo fanout, filtering, and isolation" icon="workflow" related=["tick-boundaries","shared-submission"] %}
`tick` captures one `now` value for the complete cycle. Every selected repo gets the same scheduled time and observation time for that schedule. `submitTick` builds `item.tick = { scheduledAt, cron, tz }`, adds repo context, and evaluates the schedule's CEL expression. A false expression increments `skipped` and does not submit an Event.

Matching candidates run with concurrency `4`. `Effect.result` turns each typed expression or engine failure into a per-candidate result. The cycle logs and records a `ScheduleTickFailure`, then continues with sibling repos. The returned `ScheduleCycle` reports loop count, fanout count, submissions, skips, failures, and the next boundary.

The dedup key and Item key have different jobs. The scheduled time makes each Tick a distinct Event. The repo-level Item key groups those Events under the same loop and repo, so the existing engine can supersede an unstarted older Tick or queue behind a running one.

{% code file="packages/orchestrator/src/schedule-triggers.ts" from=143 to=186 expect="      const submitTick = Effect.fn(\"ScheduleTriggers.submitTick\")(function* (" /%}

{% code file="packages/orchestrator/src/schedule-triggers.ts" from=188 to=251 expect="      const tick = Effect.fn(\"ScheduleTriggers.tick\")(function* (instance: LoadedInstance) {" /%}
{% /section %}
{% /group %}

{% group label="Shared trigger submission" %}
{% section id="shared-submission" title="One Submission contract for all streams" icon="git-merge" related=["tick-fanout","schedule-proof"] %}
The new `triggerSubmission` constructor owns the common routing fields: Event identity and payload, loop and step names, approval requirement, managed repo, default-branch revision, and agent task. Both `PollingTriggers` and `ScheduleTriggers` call it before `RunEngine.submit`.

This is the point where the schedule stream joins the existing lifecycle. `RunEngine.submit` records and claims the Submission, interrupts an unstarted superseded Run when required, and launches each claimed Run through the existing workflow.

{% code file="packages/orchestrator/src/trigger-submission.ts" from=21 to=48 expect="interface TriggerSubmissionOptions {" /%}

{% code file="packages/engine/src/engine.ts" from=98 to=108 expect="  const submit = Effect.fn(\"RunEngine.submit\")(function* (submission: Submission) {" /%}

{% callout tone="warn" %}
The PR does not add a schedule-specific downstream blocking or Ask path. The README states that blocking moments are UI-only, but the new tests verify only that a schedule Run reaches the approval-gated `Waiting` state. They do not verify a UI surface or Ask transport.
{% /callout %}
{% /section %}
{% /group %}

{% group label="Regression proof" %}
{% section id="schedule-proof" title="Boundary, persistence, and failure scenarios" icon="beaker" related=["tick-boundaries","tick-fanout","shared-submission"] %}
The tests use Effect's test clock for time behavior, a captured `RunEngine` seam for fanout, and local SQLite for restart durability.

{% tests %}
{% test name="selected repo fanout in an IANA zone" kind="unit" ref="packages/orchestrator/test/schedule-triggers.test.ts" asserts=["selects only repos with the requested tag","converts 09:00 Europe/Warsaw to the expected UTC Tick","keeps scheduledAt separate from receivedAt","reports the next zoned cron boundary"] %}This covers selector pruning, CEL repo and Tick context, payload shape, and one Event per selected repo.{% /test %}
{% test name="exact boundary and latest-missed catch-up" kind="unit" ref="packages/orchestrator/test/schedule-triggers.test.ts" asserts=["includes an exact cron minute","after 365 seconds emits only the 10:06 Tick","does not replay 10:01 through 10:05"] %}This protects minute normalization and the single latest-occurrence rule.{% /test %}
{% test name="sleep to the next cron boundary" kind="unit" ref="packages/orchestrator/test/schedule-triggers.test.ts" asserts=["runs once at startup","does not wake before the boundary","emits the next minute Tick at the boundary"] %}This separates schedule timing from the GitHub poll interval.{% /test %}
{% test name="sibling failure isolation" kind="unit" ref="packages/orchestrator/test/schedule-triggers.test.ts" asserts=["records one EnginePersistenceError","still submits the healthy repo","reports fanout and failure counts"] %}A typed failure for one repo does not stop another repo in the same cycle.{% /test %}
{% test name="durable Event deduplication" kind="unit" ref="packages/orchestrator/test/schedule-triggers.test.ts" asserts=["persists the Tick payload","returns the same Run for a repeated Tick","returns the same Run after rebuilding the SQLite-backed engine"] %}This proves that scheduled-time identity survives an engine restart.{% /test %}
{% test name="invalid schedule time zone" kind="unit" ref="packages/config/test/config.test.ts" asserts=["rejects a non-IANA tz during loop parsing","reports a schema-stage error"] %}This adds boundary proof for the existing branded `TimeZone` schema.{% /test %}
{% /tests %}
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-pr-diff" title="Full PR diff" icon="file-diff" %}
Use this complete diff for the final verification sweep, including the package export, README, changeset, and polling refactor.

{% files /%}
{% /section %}
{% /group %}
