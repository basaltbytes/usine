import { ChangeBus } from "@usine/core/changes";
import { EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { CycleGeneration } from "@usine/core/cycle-budget";
import { RunId } from "@usine/core/run";
import { RunAgain } from "@usine/core/run/again";
import * as RunState from "@usine/core/run/state";
import { type Brand, Crypto, DateTime, Effect, Match, Option, Schema } from "effect";
import { RunDatabase } from "../database/database.ts";
import {
  Claimed,
  CycleBlocked,
  Ignored,
  Queued,
  type RevokeScope,
  reopeningOf,
  runIdFor,
  Submission,
  SubmissionResult,
  Suppressed,
} from "../engine/submission.ts";
import { RunOperationRejectedError, RunRetryBlockedError } from "../engine/error.ts";
import { type RunAgainRequest, runAgainSubmission } from "../engine/run-again.ts";
import {
  cameBack,
  claimRun,
  resightEvent,
  suppressionDecision,
  type Settlement,
} from "../engine/lifecycle.ts";
import { persistence } from "./codec.ts";
import { type RunQueries, runTransaction } from "./queries/queries.ts";
import { queueQueries, type QueuedEvents } from "./queries/queue.ts";
import { TranscriptCodec } from "./transcript/codec.ts";

const OptionalRunId = Schema.Option(RunId).pipe(
  Schema.withConstructorDefault(Effect.succeed(Option.none<RunId>())),
);

/** The result of recording an Event, with the Run it opened and the unstarted Run it superseded. */
export class Claim extends Schema.Class<Claim, Brand.Brand<"@usine/engine/store/store/Claim">>(
  "@usine/engine/internal/Claim",
)({
  result: SubmissionResult,
  /** The Run that this claim opened, not yet driven; `None` for a joined Run. */
  openedRun: OptionalRunId,
  supersededRun: OptionalRunId,
}) {}

/** Returns the `RunStore` operations that record and claim Events and open or revoke their Runs. */
export const claimOperations = Effect.gen(function* () {
  const database = yield* RunDatabase;
  const bus = yield* ChangeBus;
  const crypto = yield* Crypto.Crypto;
  const codec = yield* TranscriptCodec;
  const inTransaction = runTransaction(database, bus, codec);
  const queries = queueQueries(database);

  /** Opens the Submission's Run as `runId` unless the Item's cycle budget is used up. */
  const admitRun = Effect.fn("RunStore.admitRun")(function* (
    tx: RunQueries,
    submission: Submission,
    runId: RunId,
  ) {
    const blocked = yield* tx.cycles.admit(submission);
    if (Option.isSome(blocked))
      return CycleBlocked.make({ eventId: submission.event.id, ask: blocked.value });
    yield* tx.createRun(submission, submission.event.id, runId);
    yield* tx.cycles.reserve(submission, runId);
    return Claimed.make({ eventId: submission.event.id, runId });
  });

  const openRun = Effect.fn("RunStore.openRun")(function* (
    tx: RunQueries,
    submission: Submission,
    runId: RunId,
    supersededRun: Option.Option<RunId> = Option.none(),
  ) {
    const result = yield* admitRun(tx, submission, runId);
    return Claim.make({
      result,
      openedRun: result._tag === "Claimed" ? Option.some(runId) : Option.none(),
      supersededRun,
    });
  });

  const runIdOf = (submission: Submission) =>
    runIdFor(submission).pipe(Effect.provideService(Crypto.Crypto, crypto));

  /** Returns the Event's Run or ignore reason, or `None` if the Event isn't claimed yet. */
  const settlementOf = Effect.fn("RunStore.settlementOf")(function* (
    tx: RunQueries,
    eventId: EventId,
  ) {
    const owner = (yield* tx.runForEvent(eventId))[0];
    if (owner !== undefined) {
      const run = (yield* tx.snapshot(owner.runId)).run;
      return Option.some<Settlement>({ _tag: "Owned", run });
    }
    const ignored = (yield* tx.ignoredEvent(eventId))[0];
    return ignored === undefined
      ? Option.none<Settlement>()
      : Option.some<Settlement>({ _tag: "Ignored", reason: ignored.reason });
  });

  /**
   * Claims a recorded Event that has no Run and wasn't ignored: keeps it waiting during a
   * suppression, queues it, or opens its Run as `runId`.
   */
  const claimEvent = Effect.fn("RunStore.claimEvent")(function* (
    tx: RunQueries,
    recorded: Submission,
    runId: RunId,
  ) {
    if (!(yield* tx.cycles.isCurrentEvent(recorded))) {
      return Claim.make({
        result: Ignored.make({ eventId: recorded.event.id, reason: "superseded" }),
      });
    }
    const suppression = yield* tx.loopItems.suppression(recorded.loop, recorded.itemKey);
    if (Option.isSome(suppression)) {
      const decision = suppressionDecision(suppression.value, recorded.event.id);
      const fields = {
        eventId: recorded.event.id,
        suppressedBy: suppression.value.runId,
        loop: recorded.loop,
        itemKey: recorded.itemKey,
      };
      switch (decision._tag) {
        case "SuppressFrom":
          yield* tx.loopItems.suppressFrom(recorded.loop, recorded.itemKey, recorded.event.id);
          yield* Effect.logInfo(
            "First Item state after the Agent stopped for the operator; it waits for the operator",
            fields,
          );
          return Claim.make({
            result: Suppressed.make({ eventId: recorded.event.id, runId: suppression.value.runId }),
          });
        case "Suppress":
          yield* Effect.logInfo(
            "Item unchanged since the Agent stopped for the operator; no Run opens",
            fields,
          );
          return Claim.make({
            result: Suppressed.make({ eventId: recorded.event.id, runId: suppression.value.runId }),
          });
        case "Lift":
          yield* tx.loopItems.lift(recorded.loop, recorded.itemKey);
          yield* Effect.logInfo(
            "Item changed after the Agent stopped for the operator; the Loop acts on its new state",
            fields,
          );
      }
    }
    const blocking = yield* tx.blockingRun(recorded.loop, recorded.itemKey);
    const blockedBy = blocking[0];
    const decision = claimRun(
      blockedBy === undefined
        ? Option.none()
        : Option.some((yield* tx.snapshot(blockedBy.runId)).run),
      recorded.event.id,
      recorded.ciFailureHead,
    );
    yield* Effect.logInfo("Event claim decided", {
      eventId: recorded.event.id,
      decision: decision._tag,
    });
    switch (decision._tag) {
      case "QueueEvent":
        return Claim.make({ result: Queued.make({ eventId: recorded.event.id }) });
      case "SupersedeRun":
        yield* tx.updateState(decision.runId, decision.state);
        return yield* openRun(tx, recorded, runId, Option.some(decision.runId));
      case "OpenRun":
        return yield* openRun(tx, recorded, runId);
    }
  });

  const recordAndClaim = Effect.fn("RunStore.recordAndClaim")(function* (
    submission: Submission,
    requestedRunId: RunId,
  ) {
    yield* Effect.annotateCurrentSpan({
      eventId: submission.event.id,
      runId: requestedRunId,
      loop: submission.loop,
      itemKey: submission.itemKey,
    });
    return yield* inTransaction((tx) =>
      Effect.gen(function* () {
        const recorded = yield* tx.recordTriggerEvent(submission);
        const previous = yield* tx.loopItems.sighted(
          recorded.loop,
          recorded.itemKey,
          recorded.event.id,
        );
        // After a reopening, later sightings of the trigger's Event join the newest reopening.
        const newestReopening = yield* tx.newestReopening(recorded.event.id);
        const current = Option.getOrElse(newestReopening, () => ({
          submission: recorded,
          reopening: 0,
        }));
        const eventId = current.submission.event.id;
        const settled = yield* settlementOf(tx, eventId);
        if (Option.isNone(settled)) {
          return yield* claimEvent(
            tx,
            current.submission,
            current.reopening === 0 ? requestedRunId : yield* runIdOf(current.submission),
          );
        }
        const decision = resightEvent(settled.value, cameBack(previous, recorded.event.id));
        switch (decision._tag) {
          case "JoinRun":
            yield* Effect.logInfo("Event joined its existing Run", {
              eventId,
              runId: decision.run.id,
              state: decision.run.state._tag,
            });
            return Claim.make({ result: Claimed.make({ eventId, runId: decision.run.id }) });
          case "StayIgnored":
            yield* Effect.logInfo("Event remains ignored", { eventId, reason: decision.reason });
            return Claim.make({ result: Ignored.make({ eventId, reason: decision.reason }) });
          case "ReopenEvent": {
            const reopening = current.reopening + 1;
            const reopened = yield* tx.recordTriggerEvent(
              reopeningOf(submission, recorded.event.dedupKey, reopening),
              Option.some({ eventId: recorded.event.id, reopening }),
            );
            yield* Effect.logInfo(
              "The Item came back to the state of an Event no Attempt worked on; it opens again",
              {
                eventId,
                settled: settled.value._tag,
                reopenedEventId: reopened.event.id,
                reopening,
              },
            );
            const admittedRunId = yield* runIdOf(reopened);
            return yield* claimEvent(tx, reopened, admittedRunId);
          }
        }
      }),
    );
  }, persistence("submit event"));

  const runAgain = Effect.fn("RunStore.runAgain")(function* (
    runId: RunId,
    request: RunAgainRequest,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, agent: request.context.agent.name });
    const receivedAt = yield* DateTime.now;
    return yield* inTransaction((tx) =>
      Effect.gen(function* () {
        const current = yield* tx.snapshot(runId);
        const { loop } = current.run;
        const { itemKey } = current;
        if (!RunState.operatorActions(current.run.state).canRunAgain) {
          yield* Effect.logInfo("Run again rejected; only a succeeded or canceled Run runs again", {
            runId,
            state: current.run.state._tag,
          });
          return yield* RunOperationRejectedError.make({
            runId,
            operation: "runAgain",
            state: current.run.state._tag,
          });
        }
        const blocking = (yield* tx.blockingRun(loop, itemKey))[0];
        if (blocking !== undefined) {
          yield* Effect.logInfo("Run again rejected; another Run is open on the Item", {
            runId,
            openRunId: blocking.runId,
            loop,
            itemKey,
          });
          return yield* RunRetryBlockedError.make({
            runId,
            openRunId: blocking.runId,
            message: `Run ${runId} cannot run again: run ${blocking.runId} of loop "${loop}" is open on the same item. Cancel run ${blocking.runId}, or try again after it closes.`,
          });
        }
        const reopenedEvent = yield* tx.reopenedEvent(current.event.id);
        const trigger = Option.getOrElse(reopenedEvent, () => ({
          eventId: current.event.id,
          dedupKey: current.event.dedupKey,
        }));
        const newestReopening = yield* tx.newestReopening(trigger.eventId);
        const reopening = Option.match(newestReopening, {
          onNone: () => 1,
          onSome: (newest) => newest.reopening + 1,
        });
        const cycleBudget = yield* tx.cycles.get(itemKey);
        const generation = Option.match(cycleBudget, {
          onNone: () => CycleGeneration.make(0),
          onSome: (budget) => budget.generation,
        });
        const again = runAgainSubmission(current, request, {
          trigger: trigger.dedupKey,
          reopening,
          generation,
          receivedAt,
        });
        // Not recorded as a sighting, so a later poll of the unchanged Item finds the new Run
        // through the reopening.
        const recorded = yield* tx.recordTriggerEvent(
          again,
          Option.some({ eventId: trigger.eventId, reopening }),
        );
        yield* tx.recordRunAgain(
          recorded.event.id,
          RunAgain.make({ from: runId, requestedBy: request.requestedBy }),
        );
        const admittedRunId = yield* runIdOf(recorded);
        const result = yield* admitRun(tx, recorded, admittedRunId);
        yield* Effect.logInfo(
          "Run again decided",
          Match.valueTags(result, {
            Claimed: ({ runId: openedRunId }) => ({
              runId,
              eventId: recorded.event.id,
              reopening,
              decision: "OpenRun",
              openedRunId,
              requestedBy: Option.getOrElse(request.requestedBy, () => "none"),
            }),
            CycleBlocked: ({ ask }) => ({
              runId,
              eventId: recorded.event.id,
              reopening,
              decision: "CycleBlocked",
              askId: ask.id,
              requestedBy: Option.getOrElse(request.requestedBy, () => "none"),
            }),
          }),
        );
        return result;
      }),
    );
  }, persistence("run again"));

  const revoke = Effect.fn("RunStore.revoke")(function* (
    loop: LoopName,
    itemKey: ItemKey,
    scope: RevokeScope = "all",
  ) {
    yield* Effect.annotateCurrentSpan({ loop, itemKey, scope });
    return yield* inTransaction((tx) =>
      Effect.gen(function* () {
        yield* tx.loopItems.unmatched(loop, itemKey);
        const storedRuns = yield* tx.revokeUnstarted(loop, itemKey, scope);
        for (const row of storedRuns) {
          const current = yield* tx.snapshot(row.runId);
          if (RunState.isUnstarted(current.run.state)) {
            yield* tx.updateState(row.runId, RunState.revoke(current.run.state));
          }
        }
        return storedRuns.map((row) => row.runId);
      }),
    );
  }, persistence("revoke run"));

  const revokeQueued = Effect.fn("RunStore.revokeQueued")(function* (queued: QueuedEvents) {
    const { loop, itemKey, event } = queued.submission;
    yield* Effect.annotateCurrentSpan({ loop, itemKey, eventId: event.id });
    // Not recorded as a sighting, because the trigger can still submit this Event from a fetch
    // made before the closing Run changed the Item.
    return yield* queries.revokeQueued(loop, itemKey, queued.eventIds);
  }, persistence("revoke queued events"));

  const claimQueued = Effect.fn("RunStore.claimQueued")(function* (
    submission: Submission,
    runId: RunId,
  ) {
    return yield* inTransaction((tx) =>
      Effect.gen(function* () {
        const existing = yield* tx.runForEvent(submission.event.id);
        if (existing[0] !== undefined) {
          yield* Effect.logInfo("Queued Event already opened its Run", {
            eventId: submission.event.id,
            runId: existing[0].runId,
          });
          return Option.none<RunId>();
        }
        if ((yield* tx.ignoredEvent(submission.event.id)).length > 0) {
          return Option.none<RunId>();
        }
        if ((yield* tx.blockingRun(submission.loop, submission.itemKey)).length > 0) {
          return Option.none<RunId>();
        }
        const suppression = yield* tx.loopItems.suppression(submission.loop, submission.itemKey);
        if (Option.isSome(suppression)) {
          return Option.none<RunId>();
        }
        if (!(yield* tx.cycles.isCurrentEvent(submission))) return Option.none<RunId>();
        yield* tx.recordSettings(submission);
        return (yield* openRun(tx, submission, runId)).openedRun;
      }),
    );
  }, persistence("claim queued event"));

  return { recordAndClaim, claimQueued, runAgain, revoke, revokeQueued } as const;
});
