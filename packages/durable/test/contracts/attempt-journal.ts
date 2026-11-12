import { assert, describe, it } from "@effect/vitest";
import { AgentSessionId, ChildSessionCount } from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure } from "@usine/core/attempt/failure";
import { WorkerName } from "@usine/core/worker";
import { StepCompletion, StepResult } from "@usine/core/step/result";
import {
  DateTime,
  Duration,
  Effect,
  Equal,
  Exit,
  Option,
  References,
  Result,
  Schema,
} from "effect";

import { AttemptReport, StoredRequest } from "../../src/attempt-runtime.ts";
import { Complete } from "../../src/attempt/coordinator/rules.ts";
import {
  AttemptJournal,
  ChildProgress,
  ContinuationsSaved,
  type CoordinatorSnapshot,
  Delegate,
  Delegation,
  EncodedDecision,
  EncodedEvent,
  EncodedIntervention,
  EncodedState,
  EventSequence,
  Failed,
  Finish,
  IdleSaved,
  type Intent,
  JournalRevision,
  LedgerEntry,
  Open,
  OutputSaved,
  type ProgressChange,
  Prompted,
  QueuedInput,
  Reported,
  SessionSaved,
  Settled,
  Supervision,
  Terminal,
  ToolFinished,
  ToolStarted,
  Transition,
  UsageSaved,
} from "../../src/coordinator/journal.ts";
import { RecordedDecision } from "../../src/coordinator/wake-up.ts";
import { attemptRequest, handlerSession } from "../support.ts";
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
const encodeDecision = Schema.encodeEffect(Schema.toCodecJson(RecordedDecision));
const decodeDecision = Schema.decodeUnknownEffect(Schema.toCodecJson(RecordedDecision));
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

    it.effect("keeps a recorded decision with and without its handler session", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-handler-session");
        const attemptId = request.spec.attemptId;
        const byRule = RecordedDecision.make({ decision: Complete.make({}), handler: "rule" });
        const byModel = RecordedDecision.make({
          decision: Complete.make({ message: "Reviewed: the pull request is open." }),
          handler: "completion",
          session: Option.some(handlerSession),
        });
        const ruleJson = yield* encodeDecision(byRule).pipe(Effect.map(EncodedDecision.make));
        const modelJson = yield* encodeDecision(byModel).pipe(Effect.map(EncodedDecision.make));
        const pending = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            yield* store.decide(attemptId, EventSequence.make(1), ruleJson);
            yield* store.transition(
              attemptId,
              revision(0),
              Transition.make({ ...step("AttemptStarted"), decision: ruleJson }),
            );
            yield* store.decide(attemptId, EventSequence.make(2), modelJson);
            return yield* store.load(attemptId);
          }),
        );
        const applied = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.transition(
              attemptId,
              revision(1),
              Transition.make({ ...step("ChildReported"), decision: modelJson }),
            );
            return yield* store.load(attemptId);
          }),
        );
        const decoded = (snapshot: Option.Option<CoordinatorSnapshot>) =>
          Effect.forEach(
            Option.match(snapshot, {
              onNone: () => [],
              onSome: ({ events, pendingDecision }) => [
                ...events.map(({ decision }) => decision),
                ...Option.toArray(pendingDecision),
              ],
            }),
            (decision) => decodeDecision(decision),
          );

        const beforeApply = yield* decoded(pending);
        const afterApply = yield* decoded(applied);

        assert.deepStrictEqual(beforeApply, [byRule, byModel]);
        assert.deepStrictEqual(afterApply, [byRule, byModel]);
        assert.isTrue(
          Option.exists(applied, ({ pendingDecision }) => Option.isNone(pendingDecision)),
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

    it.effect("settles an Attempt with its outcome and outbox and refuses later transitions", () =>
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
                outbound: [
                  envelope(finished.spec.attemptId, 1),
                  envelope(finished.spec.attemptId, 2),
                ],
              }),
            );
            yield* store.reserve(canceled.spec.attemptId, [envelope(canceled.spec.attemptId, 1)]);
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
        const delivery = ({ outbox, nextOutbound }: CoordinatorSnapshot) => ({
          outbox: outbox.map(({ attemptId, sequence, payload }) => [attemptId, sequence, payload]),
          nextOutbound,
        });
        const pending = (attemptId: AttemptId, sequences: ReadonlyArray<number>) =>
          sequences.map((sequence) => [attemptId, sequence, envelope(attemptId, sequence).payload]);
        assert.deepStrictEqual(
          Option.map(reopened.finished, delivery),
          Option.some({ outbox: pending(finished.spec.attemptId, [1, 2]), nextOutbound: 3 }),
        );
        assert.deepStrictEqual(
          Option.map(reopened.canceled, delivery),
          Option.some({ outbox: pending(canceled.spec.attemptId, [1]), nextOutbound: 2 }),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("settles only an open Attempt with settleOpen, even beside a transition", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const open = storedRequest("attempt-settle-open");
        const finished = storedRequest("attempt-settle-open-finished");
        const racing = storedRequest("attempt-settle-open-racing");
        const outcome = Reported.make({ report: AttemptReport.make({ message: "Opened #1." }) });
        const finishing = step("ChildReported", {
          decision: "Complete",
          intents: [Finish.make({ outcome })],
        });
        const result = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(open);
            yield* store.open(finished);
            yield* store.open(racing);
            yield* store.transition(finished.spec.attemptId, revision(0), finishing);
            const first = yield* store.settleOpen(open.spec.attemptId);
            const again = yield* store.settleOpen(open.spec.attemptId);
            const late = yield* store
              .transition(open.spec.attemptId, revision(0), step("AttemptStarted"))
              .pipe(Effect.flip);
            const terminal = yield* store.settleOpen(finished.spec.attemptId);
            const never = yield* store.settleOpen(AttemptId.make("attempt-never-opened"));
            const [settled, transitioned] = yield* Effect.all(
              [
                store.settleOpen(racing.spec.attemptId),
                store.transition(racing.spec.attemptId, revision(0), finishing).pipe(Effect.exit),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.provideService(References.MaxOpsBeforeYield, 8));
            return { first, again, late, terminal, never, settled, transitioned };
          }),
        );
        const reopened = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            return {
              open: yield* store.load(open.spec.attemptId),
              finished: yield* store.load(finished.spec.attemptId),
              racing: yield* store.load(racing.spec.attemptId),
            };
          }),
        );
        const statusOf = (snapshot: Option.Option<CoordinatorSnapshot>) =>
          Option.map(snapshot, ({ status, revision }) => ({ status, revision }));

        assert.deepStrictEqual(result.first, Option.some(Open.make({})));
        assert.deepStrictEqual(result.again, Option.some(Settled.make({ outcome: Option.none() })));
        assert.strictEqual(result.late._tag, "StaleRevision");
        assert.deepStrictEqual(
          statusOf(reopened.open),
          Option.some({ status: Settled.make({ outcome: Option.none() }), revision: revision(1) }),
        );
        assert.deepStrictEqual(result.terminal, Option.some(Terminal.make({ outcome })));
        assert.deepStrictEqual(
          statusOf(reopened.finished),
          Option.some({ status: Terminal.make({ outcome }), revision: revision(1) }),
        );
        assert.isTrue(Option.isNone(result.never));
        // Either order is valid, but settleOpen must never settle a committed outcome.
        assert.deepStrictEqual(
          statusOf(reopened.racing),
          Option.some(
            Exit.isSuccess(result.transitioned)
              ? { status: Terminal.make({ outcome }), revision: revision(1) }
              : { status: Settled.make({ outcome: Option.none() }), revision: revision(1) },
          ),
        );
        assert.deepStrictEqual(
          result.settled,
          Option.some(
            Exit.isSuccess(result.transitioned) ? Terminal.make({ outcome }) : Open.make({}),
          ),
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

    it.effect("dies on a transition after the Attempt finished or one that finishes it twice", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-after-finish");
        const attemptId = request.spec.attemptId;
        const twiceRequest = storedRequest("attempt-finish-twice");
        const twiceId = twiceRequest.spec.attemptId;
        const outcome = Reported.make({ report: AttemptReport.make({ message: "Opened #1." }) });
        const { finished, late, twiceOpened, twice } = yield* using(
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
            const twiceOpened = yield* store.open(twiceRequest);
            const twice = yield* store
              .transition(
                twiceId,
                revision(0),
                step("ChildReported", {
                  decision: "Complete",
                  intents: [Finish.make({ outcome }), Finish.make({ outcome })],
                }),
              )
              .pipe(Effect.exit);
            return { finished, late, twiceOpened, twice };
          }),
        );
        const { after, twiceAfter } = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            return { after: yield* store.load(attemptId), twiceAfter: yield* store.load(twiceId) };
          }),
        );

        assert.isTrue(Exit.hasDies(late));
        assert.deepStrictEqual(after, Option.some(finished));
        assert.isTrue(Exit.hasDies(twice));
        assert.deepStrictEqual(twiceAfter, Option.some(twiceOpened));
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
              yield* store
                .supervise(
                  attemptId,
                  Supervision.make({
                    sessionId: AgentSessionId.make("child"),
                    held: true,
                    paused: false,
                  }),
                )
                .pipe(dies),
              yield* store
                .queueInput(
                  attemptId,
                  QueuedInput.make({
                    inputSequence: AttemptChannel.Sequence.make(1),
                    sessionId: AgentSessionId.make("child"),
                    intervention: EncodedIntervention.make({}),
                  }),
                )
                .pipe(dies),
              yield* store.forgetInput(attemptId, AttemptChannel.Sequence.make(1)).pipe(dies),
              yield* store.recordInbound(attemptId, AttemptChannel.Sequence.make(1)).pipe(dies),
            ];
            return { exits, after: yield* store.load(attemptId) };
          }),
        );

        assert.deepStrictEqual(exits, [true, true, true, true, true, true, true, true]);
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

    it.effect("applies concurrent opens, reservations, and settlements one at a time", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const opening = storedRequest("attempt-concurrent-open");
        const reserving = storedRequest("attempt-concurrent-reserve");
        const settling = storedRequest("attempt-concurrent-settle");
        const outcome = Reported.make({ report: AttemptReport.make({ message: "Opened #1." }) });
        const outcomeOf = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
          Option.match(Exit.findErrorOption(exit), {
            onNone: () =>
              Exit.isSuccess(exit) ? "succeeded" : Exit.hasDies(exit) ? "died" : "interrupted",
            onSome: (error) => error._tag,
          });
        const { opens, reservations, settlement } = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            const opens = yield* Effect.forEach(
              [1, 2, 3],
              () => store.open(opening).pipe(Effect.exit),
              { concurrency: "unbounded" },
            );
            yield* store.open(reserving);
            const reservations = yield* Effect.forEach(
              [1, 2],
              () =>
                store
                  .reserve(reserving.spec.attemptId, [envelope(reserving.spec.attemptId, 1)])
                  .pipe(Effect.exit),
              { concurrency: "unbounded" },
            );
            yield* store.open(settling);
            const [settled, transitioned] = yield* Effect.all(
              [
                store.settle(settling.spec.attemptId).pipe(Effect.exit),
                store
                  .transition(
                    settling.spec.attemptId,
                    revision(0),
                    step("ChildReported", {
                      decision: "Complete",
                      intents: [Finish.make({ outcome })],
                    }),
                  )
                  .pipe(Effect.exit),
              ],
              { concurrency: "unbounded" },
            );
            return {
              opens,
              reservations,
              settlement: { settled, transitioned },
            };
          }).pipe(
            // Yield after every operation so writes outside a transaction would interleave.
            Effect.provideService(References.MaxOpsBeforeYield, 8),
          ),
        );
        const after = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            return {
              opened: yield* store.load(opening.spec.attemptId),
              reserved: yield* store.load(reserving.spec.attemptId),
              settled: yield* store.load(settling.spec.attemptId),
            };
          }),
        );

        assert.deepStrictEqual(opens.map(outcomeOf), ["succeeded", "succeeded", "succeeded"]);
        assert.deepStrictEqual(
          Option.map(after.opened, ({ revision, request }) => ({ revision, request })),
          Option.some({ revision: revision(0), request: opening }),
        );
        assert.deepStrictEqual(reservations.map(outcomeOf).sort(), ["died", "succeeded"]);
        assert.deepStrictEqual(
          Option.map(after.reserved, ({ outbox, nextOutbound }) => ({
            outbox: outbox.map(({ sequence }) => sequence),
            nextOutbound,
          })),
          Option.some({ outbox: [1], nextOutbound: 2 }),
        );
        // Either order is valid, but a settlement must never overwrite a committed outcome.
        assert.strictEqual(outcomeOf(settlement.settled), "succeeded");
        const committed = outcomeOf(settlement.transitioned);
        assert.deepStrictEqual(
          Option.map(after.settled, ({ status, revision, events }) => ({
            status,
            revision,
            events: events.length,
          })),
          Option.some(
            committed === "succeeded"
              ? {
                  status: Settled.make({ outcome: Option.some(outcome) }),
                  revision: revision(2),
                  events: 1,
                }
              : {
                  status: Settled.make({ outcome: Option.none() }),
                  revision: revision(1),
                  events: 0,
                },
          ),
        );
        assert.include(["succeeded", "StaleRevision"], committed);
      }).pipe(Effect.scoped),
    );

    it.effect("loads one consistent snapshot while transitions commit", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-load-snapshot");
        const attemptId = request.spec.attemptId;
        const loads = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            return yield* Effect.forEach(
              Array.from({ length: 12 }, (_, index) => index),
              (index) =>
                Effect.all(
                  [
                    store.load(attemptId),
                    store.transition(
                      attemptId,
                      revision(index),
                      step(`Event${index + 1}`, { outbound: [envelope(attemptId, index + 1)] }),
                    ),
                  ],
                  { concurrency: "unbounded" },
                ).pipe(Effect.map(([loaded]) => loaded)),
            );
          }).pipe(
            // Yield after every operation so reads outside a transaction would interleave.
            Effect.provideService(References.MaxOpsBeforeYield, 8),
          ),
        );

        // Each transition appends one event and one envelope, so a consistent snapshot has as many
        // events as its revision and as many envelopes as it has reserved.
        assert.deepStrictEqual(
          loads.flatMap((loaded) =>
            Option.match(loaded, {
              onNone: () => ["missing"],
              onSome: ({ revision, events, outbox, nextOutbound }) =>
                events.length === revision && outbox.length === nextOutbound - 1
                  ? []
                  : [
                      `revision ${revision}, events ${events.length}, outbox ${outbox.length}, nextOutbound ${nextOutbound}`,
                    ],
            }),
          ),
          [],
        );
      }).pipe(Effect.scoped),
    );

    it.effect(
      "starts a delegation once and keeps its progress and first outcome across a reopen",
      () =>
        Effect.gen(function* () {
          const fixture = yield* adapter.fixture;
          const request = storedRequest("attempt-delegation-progress");
          const attemptId = request.spec.attemptId;
          const first = ChildSessionCount.make(1);
          const saved = { session: "child-1", usage: null };
          const reported = EncodedEvent.make({ _tag: "ChildReported", child: 1 });
          const { fresh, again } = yield* using(
            fixture,
            Effect.gen(function* () {
              const store = yield* journal;
              yield* store.open(request);
              yield* store.transition(
                attemptId,
                revision(0),
                step("AttemptStarted", { intents: [delegate(1)] }),
              );
              const fresh = yield* store.startDelegation(attemptId, first);
              const again = yield* store.startDelegation(attemptId, first);
              const changes: ReadonlyArray<ProgressChange> = [
                SessionSaved.make({ saved, beforePrompt: true }),
                UsageSaved.make({ usage: { totalTokens: 12 } }),
                ToolStarted.make({ callId: "call-1", tool: "bash" }),
                ToolStarted.make({ callId: "call-2", tool: "read" }),
                ToolFinished.make({ callId: "call-1" }),
                ContinuationsSaved.make({ timestamps: [1_000, 2_000] }),
                IdleSaved.make({ report: Option.some("Waiting for the operator.") }),
                OutputSaved.make({ output: "Working\n" }),
              ];
              for (const change of changes) yield* store.saveProgress(attemptId, first, change);
              return { fresh, again };
            }),
          );
          const { resumed, kept, later, snapshot } = yield* using(
            fixture,
            Effect.gen(function* () {
              const store = yield* journal;
              const resumed = yield* store.startDelegation(attemptId, first);
              yield* store.saveProgress(attemptId, first, Prompted.make({}));
              // A resumed launch saves its session before the prompt again; the receipt stays.
              yield* store.saveProgress(
                attemptId,
                first,
                SessionSaved.make({ saved, beforePrompt: true }),
              );
              const kept = yield* store.settleDelegation(attemptId, first, reported);
              const later = yield* store.settleDelegation(
                attemptId,
                first,
                EncodedEvent.make({ _tag: "ChildInterrupted", child: 1 }),
              );
              return { resumed, kept, later, snapshot: yield* store.load(attemptId) };
            }),
          );

          assert.isFalse(fresh.resumed);
          assert.deepStrictEqual(fresh.progress, ChildProgress.empty());
          assert.isTrue(again.resumed);
          assert.isTrue(resumed.resumed);
          assert.deepStrictEqual(
            resumed.progress,
            ChildProgress.make({
              saved: Option.some({ session: "child-1", usage: { totalTokens: 12 } }),
              prompted: false,
              idle: Option.some("Waiting for the operator."),
              continuations: [1_000, 2_000],
              inFlight: [{ callId: "call-2", tool: "read" }],
              output: "Working\n",
            }),
          );
          assert.deepStrictEqual(kept, reported);
          assert.deepStrictEqual(later, reported);
          assert.deepStrictEqual(
            Option.map(snapshot, ({ delegations }) =>
              delegations.map(({ progress, outcome }) => ({
                prompted: Option.map(progress, ({ prompted }) => prompted),
                outcome,
              })),
            ),
            Option.some([{ prompted: Option.some(true), outcome: Option.some(reported) }]),
          );
        }).pipe(Effect.scoped),
    );

    it.effect(
      "dies on progress for a delegation no transition decided or that hasn't started",
      () =>
        Effect.gen(function* () {
          const fixture = yield* adapter.fixture;
          const request = storedRequest("attempt-delegation-unknown");
          const attemptId = request.spec.attemptId;
          const exits = yield* using(
            fixture,
            Effect.gen(function* () {
              const store = yield* journal;
              yield* store.open(request);
              yield* store.transition(
                attemptId,
                revision(0),
                step("AttemptStarted", { intents: [delegate(1)] }),
              );
              const second = ChildSessionCount.make(2);
              return [
                yield* store.startDelegation(attemptId, second).pipe(dies),
                yield* store
                  .saveProgress(attemptId, ChildSessionCount.make(1), Prompted.make({}))
                  .pipe(dies),
                yield* store
                  .settleDelegation(attemptId, second, EncodedEvent.make({ _tag: "ChildReported" }))
                  .pipe(dies),
              ];
            }),
          );

          assert.deepStrictEqual(exits, [true, true, true]);
        }).pipe(Effect.scoped),
    );

    it.effect("keeps supervision, queued inputs, and the inbound sequence across a reopen", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-supervision");
        const attemptId = request.spec.attemptId;
        const first = AgentSessionId.make(`${attemptId}/child/1`);
        const second = AgentSessionId.make(`${attemptId}/child/2`);
        const input = (sequence: number, sessionId: AgentSessionId, message: string) =>
          QueuedInput.make({
            inputSequence: AttemptChannel.Sequence.make(sequence),
            sessionId,
            intervention: EncodedIntervention.make({ action: { _tag: "Steer", message } }),
          });
        const forgotten = yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            yield* store.supervise(
              attemptId,
              Supervision.make({ sessionId: second, held: true, paused: false }),
            );
            yield* store.supervise(
              attemptId,
              Supervision.make({ sessionId: first, held: true, paused: true }),
            );
            // A child neither held nor paused has no stored supervision.
            yield* store.supervise(
              attemptId,
              Supervision.make({ sessionId: second, held: false, paused: false }),
            );
            yield* store.queueInput(attemptId, input(3, first, "Run the tests."));
            yield* store.queueInput(attemptId, input(2, first, "Use pnpm."));
            yield* store.queueInput(attemptId, input(3, first, "Run the unit tests."));
            yield* store.queueInput(attemptId, input(4, second, "Check the lockfile."));
            yield* store.recordInbound(attemptId, AttemptChannel.Sequence.make(4));
            // An earlier sequence keeps the later next inbound sequence.
            yield* store.recordInbound(attemptId, AttemptChannel.Sequence.make(2));
            return [
              yield* store.forgetInput(attemptId, AttemptChannel.Sequence.make(4)),
              yield* store.forgetInput(attemptId, AttemptChannel.Sequence.make(4)),
            ];
          }),
        );
        const reopened = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );

        assert.deepStrictEqual(forgotten, [true, false]);
        assert.deepStrictEqual(
          Option.map(reopened, ({ supervision, inputs, nextInbound }) => ({
            supervision,
            inputs,
            nextInbound,
          })),
          Option.some({
            supervision: [Supervision.make({ sessionId: first, held: true, paused: true })],
            inputs: [input(2, first, "Use pnpm."), input(3, first, "Run the unit tests.")],
            nextInbound: AttemptChannel.Sequence.make(5),
          }),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("records the result and keeps the longest unsupervised time across a reopen", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const request = storedRequest("attempt-result");
        const attemptId = request.spec.attemptId;
        const result = StepCompletion.fromResult(
          StepResult.make({ message: "Opened #1.", facts: [] }),
        );
        yield* using(
          fixture,
          Effect.gen(function* () {
            const store = yield* journal;
            yield* store.open(request);
            yield* store.recordUnsupervised(attemptId, Duration.minutes(5));
            yield* store.recordUnsupervised(attemptId, Duration.minutes(2));
            yield* store.recordResult(attemptId, result);
          }),
        );
        const reopened = yield* using(
          fixture,
          journal.pipe(Effect.flatMap((journal) => journal.load(attemptId))),
        );

        assert.deepStrictEqual(
          Option.map(reopened, ({ result, unsupervised }) => ({ result, unsupervised })),
          Option.some({
            result: Option.some(result),
            unsupervised: Option.some(Duration.minutes(5)),
          }),
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
