---
walkthrough: 1
title: Schedule ticks from cron boundary to Run
pr: 53
commit: 350ab7e63bd17f87a1c6267d099146a4d1ea9b99
meta:
  pr: "#53"
  commit: 350ab7e63bd1
  scope: schedule trigger stream
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="Schedule ticks join the trigger pipeline" icon="clock" %}
This change adds the public `ScheduleTriggers` service. An embedder can call `tick(instance)` for one evaluation or `run(instance)` for a clock-driven loop. Each schedule loop selects managed repos, evaluates its CEL expression against a Tick payload, and submits one Event per selected repo through the existing `RunEngine`.

The main review points are the time calculation and the two identities:

- The Tick uses the latest cron minute at or before the current time. This gives one catch-up Tick after downtime, not a replay of all missed minutes. An in-memory fired-tick memory (cleared by a restart, which is the catch-up moment) keeps coarser schedules from re-submitting on every finer-grained cycle.
- The Event key uses the loop, canonical repo, and scheduled time. Repeated evaluations of the same Tick reach the durable dedup path.
- The Item key uses the canonical repo. Later Ticks for the same loop and repo therefore use the existing supersede and queue rules.

The polling stream now uses the same `triggerSubmission` constructor. This keeps schedule, issue, and pull-request Events on one Event-to-Run route.
{% /section %}
{% /group %}

{% group label="Schedule tick stream" %}
{% section id="tick-boundaries" title="Latest due Tick and next wake-up" icon="history" related=["tick-fanout"] %}
`watchedSchedules` keeps only `on: schedule` loops and applies each loop selector; the already validated cron expression is parsed once per trigger and cached. For each schedule, `latestScheduledAt` first removes seconds and milliseconds. It includes the current minute when that minute matches; otherwise it asks Effect Cron for the previous occurrence. Boundary math runs per schedule under `Effect.try`: effect's `Cron.prev`/`Cron.next` can fail inside a DST spring-forward gap even for a cron that parsed cleanly, and that failure becomes a logged `ScheduleCronFailure` on the cycle — never a defect that kills the stream.

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

The same module calculates each schedule's next strict occurrence. `run` performs a cycle immediately, chooses the earliest next occurrence, and sleeps until that boundary. With no schedules — or no computable boundary — it checks again after `IDLE_WAKE_MILLIS`.

{% code file="packages/orchestrator/src/schedule-triggers.ts" from=96 to=125 expect="const watchedSchedules = (instance: LoadedInstance): ReadonlyArray<WatchedSchedule> =>" /%}

{% code file="packages/orchestrator/src/schedule-triggers.ts" from=393 to=427 expect="      // No Effect.fn here: `run` never returns, so a named wrapper would open" /%}
{% /section %}

{% section id="tick-fanout" title="Repo fanout, filtering, and isolation" icon="workflow" related=["tick-boundaries","shared-submission"] %}
`tick` captures one `now` value for the complete cycle. Every selected repo gets the same scheduled time and observation time for that schedule, and every due schedule leaves one INFO line naming its loop, cron, tz, both times, fanout, and next boundary. `submitTick` builds `item.tick = { scheduledAt, scheduledAtLocal, cron, tz }` — the UTC identity plus the same instant in the loop's own zone — adds repo context, and evaluates the schedule's CEL expression. A false expression increments `skipped` and does not submit an Event; the fired-tick memory advances only on a successful submit, so a fixed `if:` still fires the tick it previously skipped.

Matching candidates run with concurrency `4`. `Effect.result` turns each typed expression or engine failure into a per-candidate result. The cycle logs and records a `ScheduleTickFailure`, then continues with sibling repos. The returned `ScheduleCycle` reports loop count, fanout count, submissions, skips, already-fired suppressions, failures (tick and cron alike), and the next boundary.

The dedup key and Item key have different jobs. The scheduled time makes each Tick a distinct Event. The repo-level Item key groups those Events under the same loop and repo, so the existing engine can supersede an unstarted older Tick or queue behind a running one.

{% code file="packages/orchestrator/src/schedule-triggers.ts" from=197 to=241 expect="      const submitTick = Effect.fn(\"ScheduleTriggers.submitTick\")(function* (" /%}

{% code file="packages/orchestrator/src/schedule-triggers.ts" from=243 to=392 expect="      const tick = Effect.fn(\"ScheduleTriggers.tick\")(function* (instance: LoadedInstance) {" collapsed=true /%}
{% /section %}
{% /group %}

{% group label="Shared trigger submission" %}
{% section id="shared-submission" title="One Submission contract for all streams" icon="git-merge" related=["tick-fanout","schedule-proof"] %}
The new `triggerSubmission` constructor owns the common routing fields: Event identity and payload, loop and step names, approval requirement, managed repo, default-branch revision, and agent task. Both `PollingTriggers` and `ScheduleTriggers` call it before `RunEngine.submit`.

This is the point where the schedule stream joins the existing lifecycle. `RunEngine.submit` records and claims the Submission, interrupts an unstarted superseded Run when required, and launches each claimed Run through the existing workflow.

{% code file="packages/orchestrator/src/trigger-submission.ts" from=12 to=39 expect="interface TriggerSubmissionOptions {" /%}

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
{% test name="durable Event deduplication" kind="unit" ref="packages/orchestrator/test/schedule-triggers.test.ts" asserts=["persists the Tick payload","suppresses an in-process repeat via the fired-tick memory","returns the same Run after rebuilding the SQLite-backed engine"] %}This proves that scheduled-time identity survives an engine restart.{% /test %}
{% test name="DST spring-forward gap" kind="unit" ref="packages/orchestrator/test/schedule-triggers.test.ts" asserts=["a cron minute inside the skipped hour fails only its schedule","the cycle returns instead of dying with a defect"] %}Effect's Cron.prev throws across the 2026-03-29 Europe/Warsaw gap; the stream must outlive it.{% /test %}
{% test name="coarse schedule fires once" kind="unit" ref="packages/orchestrator/test/schedule-triggers.test.ts" asserts=["a daily loop's tick is not re-submitted on the next minutely cycle","the cycle counts the suppression"] %}The fired-tick memory keeps submission counts and logs truthful.{% /test %}
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
