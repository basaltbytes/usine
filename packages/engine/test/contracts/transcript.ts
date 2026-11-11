import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  HarnessSession,
  HarnessSessionId,
  ParentSession,
  PoolLogin,
  PoolRateLimitsUpdated,
  RateLimitWindow,
  RateLimitsSnapshot,
  SessionIdle,
  SessionStarted,
  SessionTokensUpdated,
  TextOutput,
  TokenCount,
  UsdAmount,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Logger, Option, References } from "effect";

import { Submission } from "../../src/engine/submission.ts";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { RunStore } from "../../src/store/store.ts";
import {
  TranscriptAllQuery,
  TranscriptPageQuery,
  TranscriptSequence,
  TranscriptTailQuery,
  TranscriptSessionsQuery,
  TranscriptUsageQuery,
  TranscriptWorkerQuery,
} from "../../src/transcript.ts";
import { lifecycleSubmission, testAgent } from "../store/fixtures.ts";
import { type PersistenceAdapter, withPersistence } from "./adapter.ts";

export const transcriptContract = (adapter: PersistenceAdapter) => {
  describe(`${adapter.name} Transcripts contract`, () => {
    it.live("clears the parent model of an Attempt that starts without a parent session", () =>
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const runId = RunId.make("parentless-run");
          const store = yield* RunStore;
          yield* store.recordAndClaim(
            Submission.make({
              ...lifecycleSubmission,
              parentModel: Option.some(ModelId.make("openai/gpt-5.6-sol")),
            }),
            runId,
          );
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert(started._tag === "AttemptStarted");
          const attemptId = started.execution.attempt.id;
          assert.isTrue(Option.isSome(started.execution.attempt.parentModel));
          yield* store.appendTranscript(
            "outbound",
            AttemptChannel.OutboundEnvelope.make({
              version: AttemptChannel.PROTOCOL_VERSION,
              attemptId,
              sequence: AttemptChannel.Sequence.make(1),
              sentAt: DateTime.makeUnsafe("2026-08-25T00:00:01Z"),
              payload: AttemptChannel.Started.make({}),
            }),
          );
          const snapshot = yield* store.snapshot(runId);
          assert.isTrue(Option.isNone(snapshot.attempts[0]?.parentModel ?? Option.some("missing")));
        }),
      ),
    );

    it.live("writes the effective parent model back onto the Attempt", () =>
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const submission = lifecycleSubmission;
          const runId = RunId.make("started-run");
          const effectiveParentModel = ModelId.make("openai/gpt-5.6-sol");
          const store = yield* RunStore;
          yield* store.recordAndClaim(submission, runId);
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
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
      "reads each pool's newest stored snapshot across attempts and unrelated transcript output",
      () =>
        Effect.gen(function* () {
          const fixture = yield* adapter.fixture;
          yield* Effect.gen(function* () {
            const store = yield* RunStore;
            const reader = yield* RunReader;
            const currentLatestPoolRateLimits = yield* reader.latestPoolRateLimits;
            assert.deepStrictEqual(currentLatestPoolRateLimits, []);
            const at = DateTime.makeUnsafe("2026-10-29T00:00:00Z");
            const session = ParentSession.make({
              id: AgentSessionId.make("pool-session"),
              agent: testAgent.name,
              brain: testAgent.brain,
            });
            const high = PoolRateLimitsUpdated.make({
              session,
              pool: "chatgptPlan",
              login: Option.some(PoolLogin.make("first@example.com")),
              rateLimits: RateLimitsSnapshot.make({
                limitId: Option.none(),
                limitName: Option.none(),
                secondary: Option.none(),
                primary: Option.some(
                  RateLimitWindow.make({
                    usedPercent: 85,
                    windowDurationMinutes: Option.some(300),
                    resetsAt: Option.some(DateTime.add(at, { hours: 1 })),
                  }),
                ),
              }),
            });
            const low = PoolRateLimitsUpdated.make({
              ...high,
              login: Option.some(PoolLogin.make("second@example.com")),
              rateLimits: RateLimitsSnapshot.make({
                ...high.rateLimits,
                primary: Option.some(
                  RateLimitWindow.make({
                    usedPercent: 20,
                    windowDurationMinutes: Option.some(300),
                    resetsAt: Option.some(DateTime.add(at, { hours: 2 })),
                  }),
                ),
              }),
            });
            const logLevels: Array<string> = [];
            const logger = Logger.make<unknown, void>(({ logLevel }) => {
              logLevels.push(logLevel);
            });
            const logging = Logger.layer([logger]);
            const other = PoolRateLimitsUpdated.make({ ...high, pool: "claudePlan" });
            for (const [index, report] of [high, low].entries()) {
              const runId = RunId.make(`pool-run-${index}`);
              yield* store.recordAndClaim(
                Submission.make({
                  ...lifecycleSubmission,
                  itemKey: ItemKey.make(`pool-item-${index}`),
                  event: Event.make({
                    ...lifecycleSubmission.event,
                    id: EventId.make(`pool-event-${index}`),
                    dedupKey: DedupKey.make(`pool-dedup-${index}`),
                  }),
                }),
                runId,
              );
              const started = yield* store.beginAttempt(
                runId,
                WorkerName.make("local"),
                Option.none(),
              );
              assert(started._tag === "AttemptStarted");
              const attemptId = started.execution.attempt.id;
              let sequence = 0;
              const append = (payload: AttemptChannel.OutboundPayload) =>
                store
                  .appendTranscript(
                    "outbound",
                    AttemptChannel.OutboundEnvelope.make({
                      version: AttemptChannel.PROTOCOL_VERSION,
                      attemptId,
                      sequence: AttemptChannel.Sequence.make(++sequence),
                      sentAt: at,
                      payload,
                    }),
                  )
                  .pipe(
                    Effect.provide(logging),
                    Effect.provideService(References.MinimumLogLevel, "Debug"),
                  );
              yield* append(AttemptChannel.SessionEvent.make({ event: report }));
              if (index === 0) yield* append(AttemptChannel.SessionEvent.make({ event: other }));
              for (let i = 0; i < 205; i++)
                yield* append(
                  AttemptChannel.SessionEvent.make({
                    event: TextOutput.make({ session, text: "More activity" }),
                  }),
                );
              yield* store.appendTranscript(
                "outbound",
                AttemptChannel.OutboundEnvelope.make({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId,
                  sequence: AttemptChannel.Sequence.make(1),
                  sentAt: DateTime.add(at, { days: 1 }),
                  payload: AttemptChannel.SessionEvent.make({ event: index === 0 ? low : high }),
                }),
              );
              const nextLatestPoolRateLimits = yield* reader.latestPoolRateLimits;
              assert.deepStrictEqual(new Set(nextLatestPoolRateLimits), new Set([report, other]));
            }
            assert.deepStrictEqual(new Set(logLevels), new Set(["Debug"]));
          }).pipe(Effect.provide(fixture.open));
        }).pipe(Effect.scoped),
    );
    it.live("preserves each Claude window across interleaved children and store restarts", () =>
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
          id: AgentSessionId.make("claude-child-a"),
          parentId: AgentSessionId.make("pool-parent"),
          agent: testAgent.name,
          brain: BrainSpec.make({ ...testAgent.brain, harness: Harness.make("claude") }),
        });
        const second = ChildSession.make({ ...first, id: AgentSessionId.make("claude-child-b") });
        const report = (
          session: ChildSession,
          primary: RateLimitsSnapshot["primary"],
          secondary: RateLimitsSnapshot["secondary"],
        ) =>
          PoolRateLimitsUpdated.make({
            session,
            pool: "claudePlan",
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
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
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
        }).pipe(Effect.provide(fixture.open));
        yield* Effect.gen(function* () {
          const [latest] = yield* (yield* RunReader).latestPoolRateLimits;
          assert.deepStrictEqual(latest, report(second, reset, window(40, 10_080)));
        }).pipe(Effect.provide(fixture.open));
      }).pipe(Effect.scoped),
    );
    it.live(
      "keeps the latest worker notice beyond transcript pages and replaces it on recovery",
      () =>
        Effect.gen(function* () {
          const fixture = yield* adapter.fixture;
          yield* Effect.gen(function* () {
            const store = yield* RunStore;
            const runId = RunId.make("worker-notice-run");
            yield* store.recordAndClaim(lifecycleSubmission, runId);
            const started = yield* store.beginAttempt(
              runId,
              WorkerName.make("remote"),
              Option.none(),
            );
            assert(started._tag === "AttemptStarted");
            const attemptId = started.execution.attempt.id;
            const at = DateTime.makeUnsafe("2026-10-28T00:00:00Z");
            let sequence = 0;
            const append = (payload: AttemptChannel.OutboundPayload) =>
              store.appendTranscript(
                "outbound",
                AttemptChannel.OutboundEnvelope.make({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId,
                  sequence: AttemptChannel.Sequence.make(++sequence),
                  sentAt: at,
                  payload,
                }),
              );
            const query = TranscriptWorkerQuery.make({ attemptId });
            const currentTranscript = yield* store.transcript(query);
            assert.deepStrictEqual(currentTranscript, []);
            const silent = AttemptChannel.WorkerUnresponsive.make({
              worker: WorkerName.make("remote"),
              lastAnsweredAt: at,
              reason: "SSH timed out",
              unansweredProbes: 3,
            });
            yield* append(silent);
            for (let i = 0; i < 205; i++)
              yield* append(
                AttemptChannel.Started.make({
                  parentModel: Option.some(ModelId.make("test-model")),
                }),
              );
            assert.deepStrictEqual(
              (yield* store.transcript(query)).map(({ envelope }) => envelope.payload),
              [silent],
            );
            const recovered = AttemptChannel.WorkerResponsive.make({
              worker: silent.worker,
              lastAnsweredAt: at,
            });
            yield* append(recovered);
            assert.deepStrictEqual(
              (yield* store.transcript(query)).map(({ envelope }) => envelope.payload),
              [recovered],
            );
            yield* append(silent);
            assert.deepStrictEqual(
              (yield* store.transcript(query)).map(({ envelope }) => envelope.payload),
              [silent],
            );
          }).pipe(Effect.provide(fixture.open));
        }).pipe(Effect.scoped),
    );
    it.live("reads each session's highest token report, wherever it sits in the transcript", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const runId = RunId.make("usage-run");
        yield* Effect.gen(function* () {
          const store = yield* RunStore;
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert(started._tag === "AttemptStarted");
          const attemptId = started.execution.attempt.id;
          const parent = ParentSession.make({
            id: AgentSessionId.make("usage-parent"),
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          const child = ChildSession.make({
            id: AgentSessionId.make("usage-child"),
            parentId: parent.id,
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          const events = [
            SessionTokensUpdated.make({ session: parent, totalTokens: TokenCount.make(100) }),
            SessionTokensUpdated.make({
              session: child,
              totalTokens: TokenCount.make(40),
              costUsd: Option.some(UsdAmount.make(0.4)),
            }),
            TextOutput.make({ session: parent, text: "Delegated the fix." }),
            SessionTokensUpdated.make({ session: parent, totalTokens: TokenCount.make(250) }),
            SessionTokensUpdated.make({
              session: child,
              totalTokens: TokenCount.make(90),
              costUsd: Option.some(UsdAmount.make(1.25)),
            }),
            // A lower report after a higher one never lowers the session's usage.
            SessionTokensUpdated.make({ session: parent, totalTokens: TokenCount.make(200) }),
          ];
          for (const [index, event] of events.entries()) {
            yield* store.appendTranscript(
              "outbound",
              AttemptChannel.OutboundEnvelope.make({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: AttemptChannel.Sequence.make(index + 1),
                sentAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
                payload: AttemptChannel.SessionEvent.make({ event }),
              }),
            );
          }
          const usage = yield* store.transcript(TranscriptUsageQuery.make({ attemptId }));
          assert.deepStrictEqual(
            usage.map(({ envelope }): readonly [string, number, number | null] | null =>
              envelope.payload._tag === "SessionEvent" &&
              envelope.payload.event._tag === "SessionTokensUpdated"
                ? [
                    envelope.payload.event.session.id,
                    envelope.payload.event.totalTokens,
                    Option.getOrNull(envelope.payload.event.costUsd),
                  ]
                : null,
            ),
            [
              ["usage-parent", 250, null],
              ["usage-child", 90, 1.25],
            ],
          );
        }).pipe(Effect.provide(fixture.open));
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
