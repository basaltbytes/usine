import { jsonKey } from "@usine/core/json-key";
import { type AccessDenied, requirePermission } from "@usine/core/access";
import { Agent } from "@usine/core/agent";
import { type AttemptId } from "@usine/core/attempt";
import type { LoadedInstance } from "@usine/config/instance";
import { type RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import {
  RunEngine,
  type RunStoreError,
  type UnconfirmedStop,
  UnconfirmedStops,
} from "@usine/engine/engine";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { LoopControl } from "@usine/engine/loop-control";
import { RunReader, type RunSnapshot, summarizeRun } from "@usine/engine/run-reader";
import {
  type TranscriptEntry,
  TranscriptPageQuery,
  TranscriptSequence,
  TranscriptSessionsQuery,
} from "@usine/engine/transcript";
import { Array as EffectArray, Context, Effect, Layer, Match, Option, Schema } from "effect";
import { settledItemState } from "../../board/items.ts";
import { WorkerStatus } from "../../worker-status.ts";
import { repositoryScope } from "../access.ts";
import { machineView, quotaWaits } from "../machines.ts";
import { fillText } from "../page.ts";
import {
  declaredWorkers,
  readEngineWaits,
  readTranscript,
  readUnrecordedEnds,
  runDuration,
  runSummaryView,
  runView,
  transcriptEvent,
} from "../projection.ts";
import { RunDetailView, UnconfirmedStopView } from "../run.ts";
import {
  ColdTranscriptRequest,
  TranscriptAttemptNotFoundError,
  TranscriptPayload,
  type TranscriptRequest,
} from "../transcript.ts";
import { RunUsageReader, runUsageSource } from "../usage.ts";
import {
  AttemptReportView,
  RunBriefView,
  type RunTextPart,
  RunTextPageView,
  RunTranscriptCursor,
  RunTranscriptPageView,
  type TranscriptTextView,
  runTextPage,
  textExcerpt,
  transcriptEntries,
  transcriptPageBytes,
} from "./view.ts";

/** The transcript rows that one read of a transcript page loads. */
const TRANSCRIPT_PAGE_ROWS = 20;

const sameAgent = Schema.toEquivalence(Agent);

const makeRunPages = Effect.gen(function* () {
  const reader = yield* RunReader;
  const controls = yield* LoopControl;
  const itemReader = yield* ItemProjectionReader;
  const usageReader = yield* RunUsageReader;
  const stops = yield* UnconfirmedStops;
  const engine = yield* Effect.serviceOption(RunEngine);
  const readWaits = readEngineWaits(engine);
  const workerStatus = yield* WorkerStatus;

  /**
   * Returns the unconfirmed stop on the Item of the open Run of `snapshot`, which keeps
   * the Run from starting an Attempt, or null.
   */
  const blockingStop = Effect.fn("Operator.blockingStop")(function* (
    snapshot: RunSnapshot,
    unconfirmedStops: ReadonlyArray<UnconfirmedStop>,
  ) {
    if (!RunState.isOpen(snapshot.run.state)) return null;
    const stop = unconfirmedStops.find(({ itemKey }) => itemKey === snapshot.itemKey);
    if (stop === undefined) return null;
    const fields = {
      runId: snapshot.run.id,
      unstoppedRunId: stop.runId,
      attemptId: stop.attemptId,
    };
    yield* Effect.annotateCurrentSpan(fields);
    const attempts =
      stop.runId === snapshot.run.id
        ? snapshot.attempts
        : (yield* reader.inspect(stop.runId)).attempts;
    const attempt = attempts.find(({ id }) => id === stop.attemptId);
    if (attempt === undefined) {
      yield* Effect.logWarning(
        "The Run with the unconfirmed stop has no such Attempt; the Run view shows no wait",
        fields,
      );
      return null;
    }
    return UnconfirmedStopView.make({
      runId: stop.runId,
      attemptNumber: attempt.number,
      worker: stop.worker,
    });
  });

  /** Reads a Run's snapshot and what its detail and brief show besides the transcript. */
  const runContext = Effect.fn("Operator.runContext")(function* (
    instance: LoadedInstance,
    runId: RunId,
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    const [snapshot, states, unconfirmedStops, inFlight, provisioning] = yield* Effect.all(
      [
        reader.inspect(runId),
        controls.states,
        stops.list,
        workerStatus.machines,
        workerStatus.provisioning,
      ] as const,
      { concurrency: "unbounded" },
    );
    yield* requirePermission("read", repositoryScope(instance, snapshot.repository));
    const openAttempt = snapshot.attempts.find((attempt) => Option.isNone(attempt.outcome));
    // The machines are oldest first, so the last is the newest Attempt's.
    const machine = [...inFlight]
      .reverse()
      .find(
        (candidate) =>
          candidate.state !== "deleting" &&
          (Option.contains(candidate.runId, runId) ||
            (openAttempt !== undefined && Option.contains(candidate.attemptId, openAttempt.id))),
      );
    const paused = new Set(states.filter((state) => state.paused).map((state) => state.loop));
    const [usage, unrecordedEnds, settled, unconfirmedStop, engineWaits] = yield* Effect.all(
      [
        usageReader.read(runUsageSource(snapshot)),
        readUnrecordedEnds(reader, snapshot),
        settledItemState(snapshot.itemKey).pipe(
          Effect.provideService(ItemProjectionReader, itemReader),
        ),
        blockingStop(snapshot, unconfirmedStops),
        readWaits,
      ],
      { concurrency: "unbounded" },
    );
    const currentAgent = instance.agents.find(({ name }) => name === snapshot.agent.name);
    return {
      snapshot,
      paused,
      runWorkers: declaredWorkers(instance.config.workers),
      waits: quotaWaits(provisioning),
      engineWaits,
      agentDefinitionChanged:
        currentAgent !== undefined && !sameAgent(snapshot.agent, currentAgent.agent),
      worker: snapshot.attempts.at(-1)?.worker ?? null,
      settledItemState: Option.getOrNull(settled),
      duration: runDuration(snapshot.attempts, unrecordedEnds),
      usage,
      unconfirmedStop,
      machine: machine === undefined ? null : machineView(machine),
    };
  });

  const detail = Effect.fn("Operator.detail")(function* (
    instance: LoadedInstance,
    runId: RunId,
    request: TranscriptRequest = ColdTranscriptRequest.make(),
  ) {
    const { snapshot, paused, runWorkers, waits, engineWaits, ...context } = yield* runContext(
      instance,
      runId,
    );
    const [transcript, sessionState] = yield* Effect.all(
      [
        readTranscript(reader, snapshot, request),
        Effect.forEach(
          snapshot.attempts.filter((attempt) => Option.isNone(attempt.outcome)),
          (attempt) => reader.transcript(TranscriptSessionsQuery.make({ attemptId: attempt.id })),
          { concurrency: "unbounded" },
        ),
      ],
      { concurrency: "unbounded" },
    );
    return RunDetailView.make({
      ...context,
      run: runView(snapshot, paused, runWorkers, waits, engineWaits),
      eventDedupKey: snapshot.event.dedupKey,
      eventPayload: snapshot.event.payload,
      transcript: transcript.events,
      sessionState: sessionState.flat().map(transcriptEvent),
      earlierTranscript: transcript.earlier,
    });
  });

  const brief = Effect.fn("Operator.brief")(function* (instance: LoadedInstance, runId: RunId) {
    const { snapshot, paused, runWorkers, waits, engineWaits, usage, ...context } =
      yield* runContext(instance, runId);
    const report = EffectArray.findLast(snapshot.attempts, (attempt) =>
      Option.exists(attempt.result, ({ message }) => message !== ""),
    );
    const view = RunBriefView.make({
      ...context,
      run: runSummaryView(summarizeRun(snapshot), paused, runWorkers, waits, engineWaits),
      task: textExcerpt(snapshot.task),
      resultMessage: Option.match(snapshot.step.result, {
        onNone: () => null,
        onSome: ({ message }) => textExcerpt(message),
      }),
      report: Option.match(
        Option.flatMap(report, (attempt) =>
          Option.map(attempt.result, ({ message }) => ({ attempt, message })),
        ),
        {
          onNone: () => null,
          onSome: ({ attempt, message }) =>
            AttemptReportView.make({
              attemptId: attempt.id,
              number: attempt.number,
              report: textExcerpt(message),
            }),
        },
      ),
      eventDedupKey: snapshot.event.dedupKey,
      usage: { tokens: usage.tokens, pools: usage.pools },
    });
    yield* Effect.logDebug("Read a Run brief", {
      runId,
      attempts: snapshot.attempts.length,
      taskLength: snapshot.task.length,
    });
    return view;
  });

  const runText = Effect.fn("Operator.runText")(function* (
    instance: LoadedInstance,
    runId: RunId,
    part: RunTextPart,
    attempt: Option.Option<AttemptId>,
    offset: number,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, part, offset });
    const snapshot = yield* reader.inspect(runId);
    yield* requirePermission("read", repositoryScope(instance, snapshot.repository));
    if (part !== "report") {
      const text = Match.value(part).pipe(
        Match.when("task", () => snapshot.task),
        Match.when("result", () =>
          Option.match(snapshot.step.result, {
            onNone: () => "",
            onSome: ({ message }) => message,
          }),
        ),
        Match.when("event", () => jsonKey(snapshot.event.payload)),
        Match.exhaustive,
      );
      return runTextPage(runId, part, null, text, offset);
    }
    const reported = Option.match(attempt, {
      onNone: () =>
        EffectArray.findLast(snapshot.attempts, (candidate) => Option.isSome(candidate.result)),
      onSome: (id) => EffectArray.findFirst(snapshot.attempts, (candidate) => candidate.id === id),
    });
    if (Option.isSome(attempt) && Option.isNone(reported))
      return yield* TranscriptAttemptNotFoundError.make({ runId, attemptId: attempt.value });
    return Option.match(reported, {
      onNone: () => runTextPage(runId, part, null, "", offset),
      onSome: (found) =>
        runTextPage(
          runId,
          part,
          found.id,
          Option.match(found.result, { onNone: () => "", onSome: ({ message }) => message }),
          offset,
        ),
    });
  });

  const encodePayload = Schema.encodeEffect(Schema.toCodecJson(TranscriptPayload));
  /** Returns a transcript entry's kind, session, and JSON text without either. */
  const transcriptText = Effect.fn("Operator.transcriptText")(function* (entry: TranscriptEntry) {
    const event = transcriptEvent(entry);
    const encoded = yield* encodePayload(event.payload).pipe(Effect.orDie);
    const fields = Schema.is(Schema.JsonObject)(encoded) ? encoded : {};
    const sessionEvent = event.payload._tag === "SessionEvent" ? event.payload.event : undefined;
    const body =
      sessionEvent !== undefined && Schema.is(Schema.JsonObject)(fields.event)
        ? fields.event
        : fields;
    const { _tag: _kind, session: _session, ...rest } = body;
    return {
      sequence: event.sequence,
      receivedAt: event.receivedAt,
      direction: event.direction,
      kind: sessionEvent?._tag ?? event.payload._tag,
      session: sessionEvent?.session.id ?? null,
      text: jsonKey(rest),
    };
  });

  const transcriptPage = Effect.fn("Operator.transcriptPage")(function* (
    instance: LoadedInstance,
    runId: RunId,
    attempt: Option.Option<AttemptId>,
    before: Option.Option<TranscriptSequence>,
    offset: number,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, offset });
    const snapshot = yield* reader.inspect(runId);
    yield* requirePermission("read", repositoryScope(instance, snapshot.repository));
    const selected = Option.match(attempt, {
      onNone: () => Option.fromUndefinedOr(snapshot.attempts.at(-1)),
      onSome: (id) => EffectArray.findFirst(snapshot.attempts, (candidate) => candidate.id === id),
    });
    if (Option.isNone(selected)) {
      if (Option.isSome(attempt))
        return yield* TranscriptAttemptNotFoundError.make({ runId, attemptId: attempt.value });
      return RunTranscriptPageView.make({
        runId,
        attemptId: null,
        attemptNumber: null,
        entries: [],
        next: null,
      });
    }
    const { id: attemptId, number } = selected.value;
    const views: Array<TranscriptTextView> = [];
    let used = transcriptPageBytes(runId, attemptId, number);
    let cursor = before;
    let start = offset;
    let next: RunTranscriptCursor | null = null;
    let reads = 0;
    while (true) {
      reads += 1;
      const rows = yield* reader.transcript(
        TranscriptPageQuery.make({ attemptId, before: cursor, limit: TRANSCRIPT_PAGE_ROWS }),
      );
      const newestFirst = [...rows].reverse();
      const texts = yield* Effect.forEach(newestFirst, transcriptText);
      const filled = fillText(transcriptEntries(texts), start, used, views.length > 0);
      views.push(...filled.views);
      used = filled.used;
      const stopped = filled.next === null ? undefined : texts[filled.next.index];
      if (filled.next !== null && stopped !== undefined) {
        next = RunTranscriptCursor.make({
          attempt: attemptId,
          before: TranscriptSequence.make(stopped.sequence + 1),
          offset: filled.next.offset,
        });
        break;
      }
      const oldest = rows[0];
      if (rows.length < TRANSCRIPT_PAGE_ROWS || oldest === undefined) break;
      cursor = Option.some(oldest.sequence);
      start = 0;
    }
    yield* Effect.logDebug("Read a transcript page", {
      runId,
      attemptId,
      entries: views.length,
      reads,
      next: next === null ? null : { before: next.before, offset: next.offset },
    });
    return RunTranscriptPageView.make({
      runId,
      attemptId,
      attemptNumber: number,
      entries: views,
      next,
    });
  });

  return { detail, brief, runText, transcriptPage } as const;
});

/** A failure to read a Run page: a refused read, a store failure, or a missing Attempt. */
type RunPagesError = AccessDenied | RunStoreError | TranscriptAttemptNotFoundError;

/** Reads one Run's detail, brief, text pages, and transcript pages. */
export class RunPages extends Context.Service<
  RunPages,
  {
    /**
     * Reads one Run and a bounded transcript page, where `request` selects the latest, newer, or
     * earlier activity.
     */
    readonly detail: (
      instance: LoadedInstance,
      runId: RunId,
      request?: TranscriptRequest,
    ) => Effect.Effect<RunDetailView, RunPagesError>;
    /**
     * Reads the Run without its event payload and transcript, with the beginnings of its task
     * prompt, result message, and newest kept report.
     */
    readonly brief: (
      instance: LoadedInstance,
      runId: RunId,
    ) => Effect.Effect<RunBriefView, RunPagesError>;
    /**
     * Reads the page of one of the Run's texts from `offset`. For `report`, reads the report of
     * `attempt`, or of the newest Attempt that kept one.
     */
    readonly runText: (
      instance: LoadedInstance,
      runId: RunId,
      part: RunTextPart,
      attempt: Option.Option<AttemptId>,
      offset: number,
    ) => Effect.Effect<RunTextPageView, RunPagesError>;
    /**
     * Reads a page of `attempt`'s transcript, or the newest Attempt's, newest entry first: from the
     * newest entry before `before`, starting `offset` into that entry's text.
     */
    readonly transcriptPage: (
      instance: LoadedInstance,
      runId: RunId,
      attempt: Option.Option<AttemptId>,
      before: Option.Option<TranscriptSequence>,
      offset: number,
    ) => Effect.Effect<RunTranscriptPageView, RunPagesError>;
  }
>()("@usine/orchestrator/operator/run-pages/run-pages/RunPages") {
  static readonly layer = Layer.effect(RunPages, makeRunPages);
}
