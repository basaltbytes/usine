import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { BillingPool, PoolDescriptor } from "@usine/core/agent/pool";
import {
  AgentSessionId,
  ChildSession,
  HarnessSession,
  HarnessSessionId,
  ParentSession,
  PoolRateLimitsUpdated,
  RateLimitWindow,
  RateLimitsSnapshot,
  SessionIdle,
  SessionStarted,
  TextOutput,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Option } from "effect";

import { RunReader } from "../../src/run-reader/run-reader.ts";
import { RunStore } from "../../src/store/store.ts";
import {
  TranscriptAllQuery,
  TranscriptPageQuery,
  TranscriptSequence,
  TranscriptTailQuery,
  TranscriptSessionsQuery,
} from "../../src/transcript.ts";
import { lifecycleSubmission, testAgent } from "../store/fixtures.ts";
import { type PersistenceAdapter, withPersistence } from "./adapter.ts";

/** A pool that only test code declares, reported one window at a time like the Claude plan. */
const separatePlan = PoolDescriptor.make({
  id: BillingPool.make("separatePlan"),
  label: "Separate plan",
  billing: "plan",
  windows: "separately",
});

export const transcriptContract = (adapter: PersistenceAdapter) => {
  describe(`${adapter.name} Transcripts contract`, () => {
    it.live("writes the effective parent model back onto the Attempt", () =>
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const submission = lifecycleSubmission;
          const runId = RunId.make("started-run");
          const effectiveParentModel = ModelId.make("openai/gpt-5.6-sol");
          const store = yield* RunStore;
          yield* store.recordAndClaim(submission, runId);
          const started = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            "local",
            Option.none(),
          );
          assert.strictEqual(started._tag, "AttemptStarted");
          if (started._tag !== "AttemptStarted") return;
          const attemptId = started.execution.attempt.id;
          yield* store.appendTranscript(
            "outbound",
            AttemptChannel.OutboundEnvelope.make({
              version: AttemptChannel.PROTOCOL_VERSION,
              attemptId,
              sequence: AttemptChannel.Sequence.make(1),
              sentAt: DateTime.makeUnsafe("2026-08-25T00:00:01Z"),
              payload: AttemptChannel.Started.make({
                parentModel: Option.some(effectiveParentModel),
              }),
            }),
          );
          const parent = ParentSession.make({
            id: AgentSessionId.make("store-parent"),
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          for (const sequence of [2, 3] as const) {
            yield* store.appendTranscript(
              "outbound",
              AttemptChannel.OutboundEnvelope.make({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: AttemptChannel.Sequence.make(sequence),
                sentAt: DateTime.makeUnsafe(`2026-08-25T00:00:0${sequence}Z`),
                payload: AttemptChannel.SessionEvent.make({
                  event: TextOutput.make({ session: parent, text: `update ${sequence}` }),
                }),
              }),
            );
          }

          const snapshot = yield* store.snapshot(runId);
          assert.deepStrictEqual(snapshot.attempts[0]?.brain, testAgent.brain);
          assert.deepStrictEqual(
            snapshot.attempts[0]?.parentModel,
            Option.some(effectiveParentModel),
          );
          const all = yield* store.transcript(TranscriptAllQuery.make({ attemptId }));
          const first = all[0];
          const last = all[2];
          assert(first !== undefined && last !== undefined);
          assert.deepStrictEqual(
            all.map(({ sequence }) => sequence),
            [1, 2, 3],
          );
          assert.deepStrictEqual(
            (yield* store.transcript(
              TranscriptTailQuery.make({ attemptId, after: first.sequence, limit: 1 }),
            )).map(({ sequence }) => sequence),
            [2],
          );
          assert.deepStrictEqual(
            (yield* store.transcript(
              TranscriptTailQuery.make({
                attemptId,
                after: TranscriptSequence.make(2),
                limit: 1,
              }),
            )).map(({ sequence }) => sequence),
            [3],
          );
          assert.deepStrictEqual(
            (yield* store.transcript(
              TranscriptPageQuery.make({
                attemptId,
                before: Option.none(),
                limit: 2,
              }),
            )).map(({ sequence }) => sequence),
            [2, 3],
          );
          assert.deepStrictEqual(
            (yield* store.transcript(
              TranscriptPageQuery.make({
                attemptId,
                before: Option.some(last.sequence),
                limit: 2,
              }),
            )).map(({ sequence }) => sequence),
            [1, 2],
          );
        }),
      ),
    );
    it.live(
      "preserves each window of a pool that reports them separately across interleaved children and store restarts",
      () =>
        Effect.gen(function* () {
          const fixture = yield* adapter.fixture;
          const window = (usedPercent: number, minutes: number) =>
            Option.some(
              RateLimitWindow.make({
                usedPercent,
                windowDurationMinutes: Option.some(minutes),
                resetsAt: Option.some(DateTime.makeUnsafe("2026-11-11T00:00:00Z")),
              }),
            );
          const first = ChildSession.make({
            id: AgentSessionId.make("child-a"),
            parentId: AgentSessionId.make("pool-parent"),
            agent: testAgent.name,
            brain: BrainSpec.make({ ...testAgent.brain, harness: Harness.make("test-harness") }),
          });
          const second = ChildSession.make({ ...first, id: AgentSessionId.make("child-b") });
          const report = (
            session: ChildSession,
            primary: RateLimitsSnapshot["primary"],
            secondary: RateLimitsSnapshot["secondary"],
          ) =>
            PoolRateLimitsUpdated.make({
              session,
              pool: separatePlan.id,
              rateLimits: RateLimitsSnapshot.make({
                limitId: Option.none(),
                limitName: Option.none(),
                primary,
                secondary,
              }),
            });
          const reset = Option.some(
            RateLimitWindow.make({
              usedPercent: 0,
              windowDurationMinutes: Option.some(300),
              resetsAt: Option.none(),
            }),
          );
          const reports = [
            report(first, window(25, 300), Option.none()),
            report(second, window(90, 300), Option.none()),
            report(first, Option.none(), window(40, 10_080)),
            report(second, reset, Option.none()),
          ];
          yield* Effect.gen(function* () {
            const store = yield* RunStore;
            const reader = yield* RunReader;
            const runId = RunId.make("interleaved-pool-run");
            yield* store.recordAndClaim(lifecycleSubmission, runId);
            const started = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              "local",
              Option.none(),
            );
            assert(started._tag === "AttemptStarted");
            const attemptId = started.execution.attempt.id;
            const expected = [
              [25, undefined],
              [90, undefined],
              [90, 40],
              [0, 40],
            ];
            for (const [index, event] of reports.entries()) {
              const envelope = AttemptChannel.OutboundEnvelope.make({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: AttemptChannel.Sequence.make(index + 1),
                sentAt: DateTime.makeUnsafe("2026-11-04T00:00:00Z"),
                payload: AttemptChannel.SessionEvent.make({ event }),
              });
              yield* store.appendTranscript("outbound", envelope);
              const [latest] = yield* reader.latestPoolRateLimits;
              assert(latest !== undefined);
              assert.deepStrictEqual(latest.session, event.session);
              assert.deepStrictEqual(
                [latest.rateLimits.primary, latest.rateLimits.secondary].map((limit) =>
                  Option.getOrUndefined(Option.map(limit, ({ usedPercent }) => usedPercent)),
                ),
                expected[index],
              );
            }
            const entries = yield* store.transcript(TranscriptAllQuery.make({ attemptId }));
            assert.deepStrictEqual(
              entries.map(({ envelope }) => envelope.payload),
              reports.map((event) => AttemptChannel.SessionEvent.make({ event })),
            );
            const original = entries[0];
            assert(original !== undefined);
            assert(original.envelope._tag === "OutboundEnvelope");
            assert(original.envelope.version === AttemptChannel.PROTOCOL_VERSION);
            yield* store.appendTranscript("outbound", original.envelope);
          }).pipe(Effect.provide(fixture.openDeclaring([separatePlan])));
          yield* Effect.gen(function* () {
            const [latest] = yield* (yield* RunReader).latestPoolRateLimits;
            assert.deepStrictEqual(latest, report(second, reset, window(40, 10_080)));
          }).pipe(Effect.provide(fixture.openDeclaring([separatePlan])));
        }).pipe(Effect.scoped),
    );
    it.live(
      "attributes interventions without adding Events and reads held sessions beyond the visible page",
      () =>
        withPersistence(
          adapter,
          Effect.gen(function* () {
            const store = yield* RunStore;
            const runId = RunId.make("intervened");
            yield* store.recordAndClaim(lifecycleSubmission, runId);
            const started = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              "local",
              Option.none(),
            );
            assert(started._tag === "AttemptStarted");
            const attemptId = started.execution.attempt.id;
            const parent = ParentSession.make({
              id: AgentSessionId.make("parent"),
              agent: testAgent.name,
              brain: testAgent.brain,
            });
            const child = ChildSession.make({
              id: AgentSessionId.make("held-child"),
              parentId: parent.id,
              agent: testAgent.name,
              brain: testAgent.brain,
            });
            let sequence = 0;
            const emit = (payload: AttemptChannel.OutboundPayload) =>
              store.appendTranscript(
                "outbound",
                AttemptChannel.OutboundEnvelope.make({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId,
                  sequence: AttemptChannel.Sequence.make(++sequence),
                  sentAt: DateTime.makeUnsafe("2026-09-12"),
                  payload,
                }),
              );
            yield* emit(
              AttemptChannel.SessionEvent.make({ event: SessionStarted.make({ session: parent }) }),
            );
            yield* emit(
              AttemptChannel.SessionEvent.make({
                event: SessionStarted.make({
                  session: child,
                  harnessSession: Option.some(
                    HarnessSession.make({
                      id: HarnessSessionId.make("vendor-1"),
                      cwd: "/worker/repo",
                    }),
                  ),
                }),
              }),
            );
            const intervention = AttemptChannel.Intervention.make({
              operator: "Philippe",
              target: AttemptChannel.ChildTarget.make({ sessionId: child.id }),
              action: AttemptChannel.OperatorMessage.make({ message: "Review with me" }),
            });
            yield* emit(
              AttemptChannel.InterventionRejected.make({
                inputSequence: AttemptChannel.Sequence.make(1),
                intervention,
                message: "Temporarily unavailable",
              }),
            );
            assert.strictEqual(
              (yield* store.snapshot(runId)).attempts[0]?.operatorIntervened,
              false,
            );
            yield* emit(
              AttemptChannel.InterventionApplied.make({
                inputSequence: AttemptChannel.Sequence.make(2),
                intervention,
                state: AttemptChannel.InterventionState.make({ held: true, paused: false }),
              }),
            );
            yield* emit(
              AttemptChannel.SessionEvent.make({ event: SessionIdle.make({ session: child }) }),
            );
            const steer = AttemptChannel.Intervention.make({
              operator: "Philippe",
              target: AttemptChannel.ParentTarget.make(),
              action: AttemptChannel.Steer.make({ message: "Fix the third finding" }),
            });
            for (const queued of [true, false])
              yield* emit(
                AttemptChannel.InterventionApplied.make({
                  inputSequence: AttemptChannel.Sequence.make(3),
                  intervention: steer,
                  state: AttemptChannel.InterventionState.make({
                    held: true,
                    paused: false,
                    queued,
                    forwardedTo: Option.some(child.id),
                  }),
                }),
              );
            yield* emit(
              AttemptChannel.InterventionApplied.make({
                inputSequence: AttemptChannel.Sequence.make(4),
                intervention: steer,
                state: AttemptChannel.InterventionState.make({
                  held: true,
                  paused: false,
                  queued: true,
                  forwardedTo: Option.some(child.id),
                }),
              }),
            );
            yield* emit(
              AttemptChannel.InterventionRejected.make({
                inputSequence: AttemptChannel.Sequence.make(4),
                intervention: steer,
                message: "The steer was withdrawn by an interruption",
              }),
            );
            for (let index = 0; index < 5; index++)
              yield* emit(
                AttemptChannel.SessionEvent.make({
                  event: TextOutput.make({ session: parent, text: `Parent progress ${index}` }),
                }),
              );
            const state = yield* store.transcript(TranscriptSessionsQuery.make({ attemptId }));
            assert.deepStrictEqual(
              state.map(({ envelope }) =>
                envelope.payload._tag === "SessionEvent"
                  ? envelope.payload.event._tag
                  : envelope.payload._tag,
              ),
              [
                "SessionStarted",
                "SessionStarted",
                "InterventionRejected",
                "InterventionApplied",
                "SessionIdle",
                "InterventionApplied",
                "InterventionRejected",
              ],
            );
            const launch = state[1]?.envelope.payload;
            assert(launch?._tag === "SessionEvent" && launch.event._tag === "SessionStarted");
            assert(Option.isSome(launch.event.harnessSession));
            assert.strictEqual(launch.event.harnessSession.value.id, "vendor-1");
            assert.strictEqual(launch.event.harnessSession.value.cwd, "/worker/repo");
            const held = state[3]?.envelope.payload;
            assert(held?._tag === "InterventionApplied");
            assert.strictEqual(held.intervention.operator, "Philippe");
            const delivered = state[5]?.envelope.payload;
            assert(delivered?._tag === "InterventionApplied");
            assert.deepStrictEqual(delivered.state.forwardedTo, Option.some(child.id));
            assert.isFalse(delivered.state.queued);
            const rejected = state[6]?.envelope.payload;
            assert(rejected?._tag === "InterventionRejected");
            assert.strictEqual(rejected.inputSequence, 4);
            const page = yield* store.transcript(
              TranscriptPageQuery.make({ attemptId, before: Option.none(), limit: 2 }),
            );
            assert(
              page.every(
                ({ envelope }) =>
                  envelope.payload._tag === "SessionEvent" &&
                  envelope.payload.event._tag === "TextOutput",
              ),
            );
            assert.strictEqual(
              (yield* store.snapshot(runId)).attempts[0]?.operatorIntervened,
              true,
            );
            assert.deepStrictEqual((yield* store.snapshot(runId)).event, lifecycleSubmission.event);
          }),
        ),
    );
  });
};
