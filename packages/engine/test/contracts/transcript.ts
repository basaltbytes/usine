import { assert, describe, it } from "@effect/vitest";
import { ModelId } from "@usine/core/agent/brain";
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
            new AttemptChannel.OutboundEnvelope({
              version: AttemptChannel.PROTOCOL_VERSION,
              attemptId,
              sequence: AttemptChannel.Sequence.make(1),
              sentAt: DateTime.makeUnsafe("2026-08-25T00:00:01Z"),
              payload: new AttemptChannel.Started({ parentModel: effectiveParentModel }),
            }),
          );
          const parent = new ParentSession({
            id: AgentSessionId.make("store-parent"),
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          for (const sequence of [2, 3] as const) {
            yield* store.appendTranscript(
              "outbound",
              new AttemptChannel.OutboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: AttemptChannel.Sequence.make(sequence),
                sentAt: DateTime.makeUnsafe(`2026-08-25T00:00:0${sequence}Z`),
                payload: new AttemptChannel.SessionEvent({
                  event: new TextOutput({ session: parent, text: `update ${sequence}` }),
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
          const all = yield* store.transcript(new TranscriptAllQuery({ attemptId }));
          const first = all[0];
          const last = all[2];
          assert(first !== undefined && last !== undefined);
          assert.deepStrictEqual(
            all.map(({ sequence }) => sequence),
            [1, 2, 3],
          );
          assert.deepStrictEqual(
            (yield* store.transcript(
              new TranscriptTailQuery({ attemptId, after: first.sequence, limit: 1 }),
            )).map(({ sequence }) => sequence),
            [2],
          );
          assert.deepStrictEqual(
            (yield* store.transcript(
              new TranscriptTailQuery({
                attemptId,
                after: TranscriptSequence.make(2),
                limit: 1,
              }),
            )).map(({ sequence }) => sequence),
            [3],
          );
          assert.deepStrictEqual(
            (yield* store.transcript(
              new TranscriptPageQuery({
                attemptId,
                before: Option.none(),
                limit: 2,
              }),
            )).map(({ sequence }) => sequence),
            [2, 3],
          );
          assert.deepStrictEqual(
            (yield* store.transcript(
              new TranscriptPageQuery({
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
            assert.deepStrictEqual(yield* reader.latestPoolRateLimits(), []);
            const at = DateTime.makeUnsafe("2026-10-29T00:00:00Z");
            const session = new ParentSession({
              id: AgentSessionId.make("pool-session"),
              agent: testAgent.name,
              brain: testAgent.brain,
            });
            const high = new PoolRateLimitsUpdated({
              session,
              pool: "chatgptPlan",
              login: Option.some(PoolLogin.make("first@example.com")),
              rateLimits: new RateLimitsSnapshot({
                limitId: Option.none(),
                limitName: Option.none(),
                secondary: Option.none(),
                primary: Option.some(
                  new RateLimitWindow({
                    usedPercent: 85,
                    windowDurationMinutes: Option.some(300),
                    resetsAt: Option.some(DateTime.add(at, { hours: 1 })),
                  }),
                ),
              }),
            });
            const low = new PoolRateLimitsUpdated({
              ...high,
              login: Option.some(PoolLogin.make("second@example.com")),
              rateLimits: new RateLimitsSnapshot({
                ...high.rateLimits,
                primary: Option.some(
                  new RateLimitWindow({
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
            const other = new PoolRateLimitsUpdated({ ...high, pool: "claudePlan" });
            for (const [index, report] of [high, low].entries()) {
              const runId = RunId.make(`pool-run-${index}`);
              yield* store.recordAndClaim(
                new Submission({
                  ...lifecycleSubmission,
                  itemKey: ItemKey.make(`pool-item-${index}`),
                  event: new Event({
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
                    new AttemptChannel.OutboundEnvelope({
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
              yield* append(new AttemptChannel.SessionEvent({ event: report }));
              if (index === 0) yield* append(new AttemptChannel.SessionEvent({ event: other }));
              for (let i = 0; i < 205; i++)
                yield* append(
                  new AttemptChannel.SessionEvent({
                    event: new TextOutput({ session, text: "More activity" }),
                  }),
                );
              yield* store.appendTranscript(
                "outbound",
                new AttemptChannel.OutboundEnvelope({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId,
                  sequence: AttemptChannel.Sequence.make(1),
                  sentAt: DateTime.add(at, { days: 1 }),
                  payload: new AttemptChannel.SessionEvent({ event: index === 0 ? low : high }),
                }),
              );
              assert.deepStrictEqual(
                new Set(yield* reader.latestPoolRateLimits()),
                new Set([report, other]),
              );
            }
            assert.deepStrictEqual(new Set(logLevels), new Set(["Debug"]));
          }).pipe(Effect.provide(fixture.open()));
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
                new AttemptChannel.OutboundEnvelope({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId,
                  sequence: AttemptChannel.Sequence.make(++sequence),
                  sentAt: at,
                  payload,
                }),
              );
            const query = new TranscriptWorkerQuery({ attemptId });
            assert.deepStrictEqual(yield* store.transcript(query), []);
            const silent = new AttemptChannel.WorkerUnresponsive({
              worker: WorkerName.make("remote"),
              lastAnsweredAt: at,
              reason: "SSH timed out",
              unansweredProbes: 3,
            });
            yield* append(silent);
            for (let i = 0; i < 205; i++)
              yield* append(
                new AttemptChannel.Started({ parentModel: ModelId.make("test-model") }),
              );
            assert.deepStrictEqual(
              (yield* store.transcript(query)).map(({ envelope }) => envelope.payload),
              [silent],
            );
            const recovered = new AttemptChannel.WorkerResponsive({
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
          }).pipe(Effect.provide(fixture.open()));
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
          const parent = new ParentSession({
            id: AgentSessionId.make("usage-parent"),
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          const child = new ChildSession({
            id: AgentSessionId.make("usage-child"),
            parentId: parent.id,
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          const events = [
            new SessionTokensUpdated({ session: parent, totalTokens: TokenCount.make(100) }),
            new SessionTokensUpdated({
              session: child,
              totalTokens: TokenCount.make(40),
              costUsd: Option.some(UsdAmount.make(0.4)),
            }),
            new TextOutput({ session: parent, text: "Delegated the fix." }),
            new SessionTokensUpdated({ session: parent, totalTokens: TokenCount.make(250) }),
            new SessionTokensUpdated({
              session: child,
              totalTokens: TokenCount.make(90),
              costUsd: Option.some(UsdAmount.make(1.25)),
            }),
            // A lower report after a higher one never lowers the session's usage.
            new SessionTokensUpdated({ session: parent, totalTokens: TokenCount.make(200) }),
          ];
          for (const [index, event] of events.entries()) {
            yield* store.appendTranscript(
              "outbound",
              new AttemptChannel.OutboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: AttemptChannel.Sequence.make(index + 1),
                sentAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
                payload: new AttemptChannel.SessionEvent({ event }),
              }),
            );
          }
          const usage = yield* store.transcript(new TranscriptUsageQuery({ attemptId }));
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
        }).pipe(Effect.provide(fixture.open()));
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
            const parent = new ParentSession({
              id: AgentSessionId.make("parent"),
              agent: testAgent.name,
              brain: testAgent.brain,
            });
            const child = new ChildSession({
              id: AgentSessionId.make("held-child"),
              parentId: parent.id,
              agent: testAgent.name,
              brain: testAgent.brain,
            });
            let sequence = 0;
            const emit = (payload: AttemptChannel.OutboundPayload) =>
              store.appendTranscript(
                "outbound",
                new AttemptChannel.OutboundEnvelope({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId,
                  sequence: AttemptChannel.Sequence.make(++sequence),
                  sentAt: DateTime.makeUnsafe("2026-09-12"),
                  payload,
                }),
              );
            yield* emit(
              new AttemptChannel.SessionEvent({ event: new SessionStarted({ session: parent }) }),
            );
            yield* emit(
              new AttemptChannel.SessionEvent({
                event: new SessionStarted({
                  session: child,
                  harnessSession: Option.some(
                    new HarnessSession({
                      id: HarnessSessionId.make("vendor-1"),
                      cwd: "/worker/repo",
                    }),
                  ),
                }),
              }),
            );
            const intervention = new AttemptChannel.Intervention({
              operator: "Philippe",
              target: new AttemptChannel.ChildTarget({ sessionId: child.id }),
              action: new AttemptChannel.OperatorMessage({ message: "Review with me" }),
            });
            yield* emit(
              new AttemptChannel.InterventionRejected({
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
              new AttemptChannel.InterventionApplied({
                inputSequence: AttemptChannel.Sequence.make(2),
                intervention,
                state: new AttemptChannel.InterventionState({ held: true, paused: false }),
              }),
            );
            yield* emit(
              new AttemptChannel.SessionEvent({ event: new SessionIdle({ session: child }) }),
            );
            const steer = new AttemptChannel.Intervention({
              operator: "Philippe",
              target: new AttemptChannel.ParentTarget(),
              action: new AttemptChannel.Steer({ message: "Fix the third finding" }),
            });
            for (const queued of [true, false])
              yield* emit(
                new AttemptChannel.InterventionApplied({
                  inputSequence: AttemptChannel.Sequence.make(3),
                  intervention: steer,
                  state: new AttemptChannel.InterventionState({
                    held: true,
                    paused: false,
                    queued,
                    forwardedTo: Option.some(child.id),
                  }),
                }),
              );
            yield* emit(
              new AttemptChannel.InterventionApplied({
                inputSequence: AttemptChannel.Sequence.make(4),
                intervention: steer,
                state: new AttemptChannel.InterventionState({
                  held: true,
                  paused: false,
                  queued: true,
                  forwardedTo: Option.some(child.id),
                }),
              }),
            );
            yield* emit(
              new AttemptChannel.InterventionRejected({
                inputSequence: AttemptChannel.Sequence.make(4),
                intervention: steer,
                message: "The steer was withdrawn by an interruption",
              }),
            );
            for (let index = 0; index < 5; index++)
              yield* emit(
                new AttemptChannel.SessionEvent({
                  event: new TextOutput({ session: parent, text: `Parent progress ${index}` }),
                }),
              );
            const state = yield* store.transcript(new TranscriptSessionsQuery({ attemptId }));
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
              new TranscriptPageQuery({ attemptId, before: Option.none(), limit: 2 }),
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
