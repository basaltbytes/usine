import { assert, describe, it } from "@effect/vitest";
import { ChildSessionCount } from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure } from "@usine/core/attempt/failure";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Equal, Exit, Option, References, Result } from "effect";

import { AttemptReport, StoredRequest } from "../../src/attempt-runtime.ts";
import {
  AttemptJournal,
  Delegate,
  Delegation,
  EncodedDecision,
  EncodedEvent,
  EncodedState,
  EventSequence,
  Failed,
  Finish,
  type Intent,
  JournalRevision,
  LedgerEntry,
  Open,
  Reported,
  Settled,
  Terminal,
  Transition,
} from "../../src/coordinator/journal.ts";
import { attemptRequest } from "../support.ts";
import type { FailingJournalFixture, JournalAdapter, JournalFixture } from "./adapter.ts";

const storedRequest = (attemptId: string, cwd = "/workspace/usine") => {
  const { spec, worker } = attemptRequest(attemptId);
  return StoredRequest.make({ spec, worker, cwd });
};

const envelope = (attemptId: AttemptId, sequence: number) =>
  AttemptChannel.OutboundEnvelope.make({
    version: AttemptChannel.PROTOCOL_VERSION,
    attemptId,
    sequence: AttemptChannel.Sequence.make(sequence),
    sentAt: DateTime.makeUnsafe("2026-11-11T09:00:00Z"),
    payload: AttemptChannel.WorkerUnresponsive.make({
      worker: WorkerName.make("local"),
      lastAnsweredAt: DateTime.makeUnsafe("2026-11-11T08:59:00Z"),
      reason: `probe ${sequence} timed out`,
    }),
  });

const delegate = (number: number, assignment?: string) =>
  Delegate.make({
    delegation: Delegation.make({
      number: ChildSessionCount.make(number),
      assignment: Option.fromUndefinedOr(assignment),
    }),
  });

const step = (
  event: string,
  options: {
    readonly decision?: string;
    readonly intents?: ReadonlyArray<Intent>;
    readonly outbound?: ReadonlyArray<AttemptChannel.OutboundEnvelope>;
  } = {},
) =>
  Transition.make({
    event: EncodedEvent.make({ _tag: event }),
    decision: EncodedDecision.make({ _tag: options.decision ?? "Delegate" }),
    state: EncodedState.make({ after: event }),
    intents: options.intents ?? [],
    outbound: options.outbound ?? [],
  });

const revision = JournalRevision.make;
const using = <A, E>(fixture: JournalFixture, work: Effect.Effect<A, E, AttemptJournal>) =>
  work.pipe(Effect.provide(fixture.open));
const journal = Effect.service(AttemptJournal);
const dies = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.exit, Effect.map(Exit.hasDies));

/** Registers the contract for `adapter`; every adapter must pass it unchanged. */
export const attemptJournalContract = (adapter: JournalAdapter) =>
  describe(`${adapter.name} attempt journal contract`, () => {
    it.effect("opens an Attempt once and keeps the first request", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-open");
        const first = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.open(request))),
        );
        const again = yield* using(
          fixture,
          journal.pipe(
            Effect.flatMap((journal) => journal.open(storedRequest("attempt-open", "/elsewhere"))),
          ),
        );
        const missing = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(AttemptId.make("attempt-none")))),
        );

        assert.deepStrictEqual(again, first);
        assert.strictEqual(again.request.cwd, "/workspace/usine");
        assert.strictEqual(first.revision, 0);
        assert.deepStrictEqual(first.status, Open.make({}));
        assert.isTrue(Option.isNone(first.state));
        assert.strictEqual(first.nextOutbound, 1);
        assert.isTrue(Option.isNone(missing));
      }).pipe(Effect.scoped),
    );

    it.effect("commits the event, decision, state, intents, and outbox together", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-transition");
        const attemptId = request.spec.attemptId;
        const started = step("AttemptStarted", {
          intents: [delegate(1), delegate(2, "Review the pull request.")],
          outbound: [envelope(attemptId, 1), envelope(attemptId, 2)],
        });
        const committed = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            return yield* store.transition(attemptId, revision(0), started);
          }),
        );
        const reopened = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );

        assert.strictEqual(committed.revision, 1);
        assert.deepStrictEqual(committed.events, [
          LedgerEntry.make({
            sequence: EventSequence.make(1),
            event: started.event,
            decision: started.decision,
          }),
        ]);
        assert.deepStrictEqual(committed.state, Option.some(started.state));
        assert.deepStrictEqual(
          committed.delegations.map(({ number, assignment }) => [number, assignment]),
          [
            [1, Option.none()],
            [2, Option.some("Review the pull request.")],
          ],
        );
        assert.deepStrictEqual(
          committed.outbox.map(({ sequence }) => sequence),
          [1, 2],
        );
        assert.strictEqual(committed.nextOutbound, 3);
        assert.strictEqual(committed.nextEvent, 2);
        assert.deepStrictEqual(reopened, Option.some(committed));
      }).pipe(Effect.scoped),
    );

    it.effect("refuses a stale revision without changing the journal", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-stale");
        const attemptId = request.spec.attemptId;
        const { before, refused } = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            const before = yield* store.transition(attemptId, revision(0), step("AttemptStarted"));
            const refused = yield* store
              .transition(
                attemptId,
                revision(0),
                step("ChildReported", { outbound: [envelope(attemptId, 1)] }),
              )
              .pipe(Effect.flip);
            return { before, refused };
          }),
        );
        const after = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );

        assert.strictEqual(refused._tag, "StaleRevision");
        assert.deepStrictEqual(
          refused._tag === "StaleRevision" ? [refused.expected, refused.actual] : [],
          [0, 1],
        );
        assert.deepStrictEqual(after, Option.some(before));
      }).pipe(Effect.scoped),
    );

    it.effect("keeps the first decision recorded for an event", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-decide");
        const attemptId = request.spec.attemptId;
        const first = EncodedDecision.make({ _tag: "Complete" });
        const later = EncodedDecision.make({ _tag: "RetryChild" });
        const recorded = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            const kept = yield* store.decide(attemptId, EventSequence.make(1), first);
            const racing = yield* store.decide(attemptId, EventSequence.make(1), later);
            return [kept, racing];
          }),
        );
        const restarted = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            const pending = yield* store.load(attemptId);
            const afterRestart = yield* store.decide(attemptId, EventSequence.make(1), later);
            const applied = yield* store.transition(
              attemptId,
              revision(0),
              step("ChildReported", { decision: "Complete" }),
            );
            const afterApply = yield* store.decide(attemptId, EventSequence.make(1), later);
            return { pending, afterRestart, applied, afterApply };
          }),
        );
        const reloaded = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );

        assert.deepStrictEqual(recorded, [first, first]);
        assert.deepStrictEqual(
          Option.map(restarted.pending, ({ pendingDecision }) => pendingDecision),
          Option.some(Option.some(first)),
        );
        assert.deepStrictEqual(restarted.afterRestart, first);
        assert.deepStrictEqual(restarted.applied.events[0]?.decision, first);
        assert.isTrue(Option.isNone(restarted.applied.pendingDecision));
        assert.deepStrictEqual(restarted.afterApply, first);
        assert.deepStrictEqual(reloaded, Option.some(restarted.applied));
        assert.deepStrictEqual(
          Option.map(reloaded, ({ revision, events, pendingDecision, nextEvent }) => ({
            revision,
            events: events.map(({ sequence, decision }) => [sequence, decision]),
            pendingDecision,
            nextEvent,
          })),
          Option.some({
            revision: revision(1),
            events: [[1, first]],
            pendingDecision: Option.none<EncodedDecision>(),
            nextEvent: EventSequence.make(2),
          }),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("dies when a transition applies a decision other than the recorded one", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-conflict");
        const attemptId = request.spec.attemptId;
        const exit = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            yield* store.decide(
              attemptId,
              EventSequence.make(1),
              EncodedDecision.make({ _tag: "Complete" }),
            );
            return yield* store
              .transition(attemptId, revision(0), step("ChildReported", { decision: "Failed" }))
              .pipe(Effect.exit);
          }),
        );
        const after = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );

        assert.isTrue(Exit.hasDies(exit));
        assert.deepStrictEqual(
          Option.map(after, ({ revision, events }) => [revision, events.length]),
          Option.some([0, 0]),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("keeps outbox order and acknowledgements across a reopen", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-outbox");
        const attemptId = request.spec.attemptId;
        yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            yield* store.transition(
              attemptId,
              revision(0),
              step("AttemptStarted", {
                outbound: [envelope(attemptId, 1), envelope(attemptId, 2)],
              }),
            );
            yield* store.reserve(attemptId, [envelope(attemptId, 3), envelope(attemptId, 4)]);
            yield* store.acknowledge(attemptId, AttemptChannel.Sequence.make(1));
          }),
        );
        const reopened = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );
        const drained = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.acknowledge(attemptId, AttemptChannel.Sequence.make(3));
            yield* store.acknowledge(attemptId, AttemptChannel.Sequence.make(3));
            return yield* store.load(attemptId);
          }),
        );

        assert.deepStrictEqual(
          Option.map(reopened, ({ outbox, nextOutbound }) => ({
            outbox: outbox.map(({ sequence, payload }) => [sequence, payload]),
            nextOutbound,
          })),
          Option.some({
            outbox: [2, 3, 4].map((sequence) => [sequence, envelope(attemptId, sequence).payload]),
            nextOutbound: 5,
          }),
        );
        assert.deepStrictEqual(
          Option.map(drained, ({ outbox, nextOutbound }) => [
            outbox.map(({ sequence }) => sequence),
            nextOutbound,
          ]),
          Option.some([[4], 5]),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("settles an Attempt with its outcome and refuses later transitions", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const finished = storedRequest("attempt-finished");
        const canceled = storedRequest("attempt-canceled");
        const outcome = Reported.make({ report: AttemptReport.make({ message: "Opened #1." }) });
        const result = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(finished);
            yield* store.open(canceled);
            const terminal = yield* store.transition(
              finished.spec.attemptId,
              revision(0),
              step("ChildReported", {
                decision: "Complete",
                intents: [Finish.make({ outcome })],
              }),
            );
            yield* store.settle(finished.spec.attemptId);
            yield* store.settle(finished.spec.attemptId);
            yield* store.settle(canceled.spec.attemptId);
            yield* store.settle(AttemptId.make("attempt-never-opened"));
            const late = yield* store
              .transition(canceled.spec.attemptId, revision(0), step("AttemptStarted"))
              .pipe(Effect.flip);
            return { terminal, late };
          }),
        );
        const reopened = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            return {
              finished: yield* store.load(finished.spec.attemptId),
              canceled: yield* store.load(canceled.spec.attemptId),
            };
          }),
        );

        assert.deepStrictEqual(result.terminal.status, Terminal.make({ outcome }));
        assert.strictEqual(result.late._tag, "StaleRevision");
        assert.deepStrictEqual(
          Option.map(reopened.finished, ({ status, revision }) => ({ status, revision })),
          Option.some({
            status: Settled.make({ outcome: Option.some(outcome) }),
            revision: revision(2),
          }),
        );
        assert.deepStrictEqual(
          Option.map(reopened.canceled, ({ status, revision }) => ({ status, revision })),
          Option.some({ status: Settled.make({ outcome: Option.none() }), revision: revision(1) }),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("stores a failed outcome", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-failed");
        const outcome = Failed.make({
          failure: AgentFailure.make({ message: "The child reported a blocker." }),
        });
        yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            yield* store.transition(
              request.spec.attemptId,
              revision(0),
              step("ChildReported", { decision: "Failed", intents: [Finish.make({ outcome })] }),
            );
          }),
        );
        const reopened = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(request.spec.attemptId))),
        );

        assert.deepStrictEqual(
          Option.map(reopened, ({ status }) => status),
          Option.some(Terminal.make({ outcome })),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("dies on a transition after the Attempt finished", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-after-finish");
        const attemptId = request.spec.attemptId;
        const outcome = Reported.make({ report: AttemptReport.make({ message: "Opened #1." }) });
        const { finished, late } = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            const finished = yield* store.transition(
              attemptId,
              revision(0),
              step("ChildReported", { decision: "Complete", intents: [Finish.make({ outcome })] }),
            );
            const late = yield* store
              .transition(attemptId, revision(1), step("ChildReported"))
              .pipe(Effect.exit);
            return { finished, late };
          }),
        );
        const after = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );

        assert.isTrue(Exit.hasDies(late));
        assert.deepStrictEqual(after, Option.some(finished));
      }).pipe(Effect.scoped),
    );

    it.effect("dies on an envelope out of sequence or for another Attempt", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-envelopes");
        const attemptId = request.spec.attemptId;
        const other = AttemptId.make("attempt-other");
        const { opened, exits } = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            const opened = yield* store.open(request);
            const exits = [
              yield* store.reserve(attemptId, [envelope(attemptId, 2)]).pipe(dies),
              yield* store
                .reserve(attemptId, [envelope(attemptId, 1), envelope(attemptId, 3)])
                .pipe(dies),
              yield* store.reserve(attemptId, [envelope(other, 1)]).pipe(dies),
              yield* store
                .transition(
                  attemptId,
                  revision(0),
                  step("AttemptStarted", { outbound: [envelope(attemptId, 2)] }),
                )
                .pipe(dies),
              yield* store
                .transition(
                  attemptId,
                  revision(0),
                  step("AttemptStarted", { outbound: [envelope(other, 1)] }),
                )
                .pipe(dies),
            ];
            return { opened, exits };
          }),
        );
        const after = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );

        assert.deepStrictEqual(exits, [true, true, true, true, true]);
        assert.deepStrictEqual(after, Option.some(opened));
      }).pipe(Effect.scoped),
    );

    it.effect("dies when a transition repeats a delegation number", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-repeated-delegation");
        const attemptId = request.spec.attemptId;
        const { first, exits } = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            const first = yield* store.transition(
              attemptId,
              revision(0),
              step("AttemptStarted", { intents: [delegate(1)] }),
            );
            const exits = [
              yield* store
                .transition(
                  attemptId,
                  revision(1),
                  step("ChildReported", { intents: [delegate(1)] }),
                )
                .pipe(dies),
              yield* store
                .transition(
                  attemptId,
                  revision(1),
                  step("ChildReported", { intents: [delegate(2), delegate(2)] }),
                )
                .pipe(dies),
            ];
            return { first, exits };
          }),
        );
        const after = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );

        assert.deepStrictEqual(exits, [true, true]);
        assert.deepStrictEqual(after, Option.some(first));
      }).pipe(Effect.scoped),
    );

    it.effect("dies on a decision for an event past the next one", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-decide-ahead");
        const attemptId = request.spec.attemptId;
        const { opened, exit } = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            const opened = yield* store.open(request);
            const exit = yield* store
              .decide(attemptId, EventSequence.make(2), EncodedDecision.make({ _tag: "Complete" }))
              .pipe(Effect.exit);
            return { opened, exit };
          }),
        );
        const after = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );

        assert.isTrue(Exit.hasDies(exit));
        assert.deepStrictEqual(after, Option.some(opened));
      }).pipe(Effect.scoped),
    );

    it.effect("dies on operations for an Attempt that was never opened", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const attemptId = AttemptId.make("attempt-never-opened");
        const { exits, after } = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            const exits = [
              yield* store.transition(attemptId, revision(0), step("AttemptStarted")).pipe(dies),
              yield* store
                .decide(
                  attemptId,
                  EventSequence.make(1),
                  EncodedDecision.make({ _tag: "Complete" }),
                )
                .pipe(dies),
              yield* store.reserve(attemptId, [envelope(attemptId, 1)]).pipe(dies),
              yield* store.acknowledge(attemptId, AttemptChannel.Sequence.make(1)).pipe(dies),
            ];
            return { exits, after: yield* store.load(attemptId) };
          }),
        );

        assert.deepStrictEqual(exits, [true, true, true, true]);
        assert.isTrue(Option.isNone(after));
      }).pipe(Effect.scoped),
    );

    it.effect("applies concurrent operations one at a time", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-concurrent");
        const attemptId = request.spec.attemptId;
        const complete = EncodedDecision.make({ _tag: "Complete" });
        const decisions = [
          complete,
          ...["RetryChild", "Failed"].map((_tag) => EncodedDecision.make({ _tag })),
        ];
        const { recorded, transitions } = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            const recorded = yield* Effect.forEach(
              decisions,
              (decision) => store.decide(attemptId, EventSequence.make(1), decision),
              { concurrency: "unbounded" },
            );
            const transitions = yield* Effect.forEach(
              ["AttemptStarted", "ChildReported", "ChildFailed"],
              (event) =>
                store
                  .transition(
                    attemptId,
                    revision(0),
                    Transition.make({
                      ...step(event, { outbound: [envelope(attemptId, 1)] }),
                      decision: recorded[0] ?? complete,
                    }),
                  )
                  .pipe(Effect.result),
              { concurrency: "unbounded" },
            );
            return { recorded, transitions };
          }).pipe(
            // Yield after every operation so unserialized reads and writes would interleave.
            Effect.provideService(References.MaxOpsBeforeYield, 8),
          ),
        );
        const after = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );

        assert.isTrue(recorded.every((decision) => Equal.equals(decision, recorded[0])));
        assert.deepStrictEqual(
          transitions
            .map((result) => (Result.isSuccess(result) ? "committed" : result.failure._tag))
            .sort(),
          ["StaleRevision", "StaleRevision", "committed"],
        );
        assert.deepStrictEqual(
          Option.map(after, ({ revision, events, outbox, nextOutbound }) => ({
            revision,
            events: events.length,
            outbox: outbox.length,
            nextOutbound,
          })),
          Option.some({ revision: revision(1), events: 1, outbox: 1, nextOutbound: 2 }),
        );
      }).pipe(Effect.scoped),
    );
  });

/** Registers the atomicity contract for an adapter that can fail a write mid-transaction. */
export const attemptJournalWriteFailureContract = (
  adapter: JournalAdapter<FailingJournalFixture>,
) =>
  describe(`${adapter.name} attempt journal write failures`, () => {
    it.effect("leaves no partial transition after a write fails", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-write-failure");
        const attemptId = request.spec.attemptId;
        const opened = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.open(request))),
        );
        const restore = yield* fixture.rejectOutboxInsert;
        const failed = yield* using(
          fixture,
          journal.pipe(
            Effect.flatMap((journal) =>
              journal.transition(
                attemptId,
                revision(0),
                step("AttemptStarted", {
                  intents: [delegate(1)],
                  outbound: [envelope(attemptId, 1)],
                }),
              ),
            ),
            Effect.flip,
          ),
        );
        const unchanged = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );
        yield* restore;
        const retried = yield* using(
          fixture,
          journal.pipe(
            Effect.flatMap((journal) =>
              journal.transition(
                attemptId,
                revision(0),
                step("AttemptStarted", {
                  intents: [delegate(1)],
                  outbound: [envelope(attemptId, 1)],
                }),
              ),
            ),
          ),
        );

        assert.strictEqual(failed._tag, "JournalError");
        assert.deepStrictEqual(unchanged, Option.some(opened));
        assert.strictEqual(retried.revision, 1);
        assert.strictEqual(retried.delegations.length, 1);
        assert.strictEqual(retried.outbox.length, 1);
      }).pipe(Effect.scoped),
    );
  });
