import { assert, describe, it } from "@effect/vitest";
import { BLOCKED_MARKER, FAILED_MARKER, QUESTION_MARKER } from "@usine/agents/runtime";
import {
  HarnessSession,
  HarnessSessionId,
  SessionStarted,
  TextOutput,
} from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import {
  AgentFailure,
  BlockedFailure,
  InfraFailure,
  ProviderCapacityFailure,
  QuestionFailure,
} from "@usine/core/attempt/failure";
import { StepCompletion, StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Ref,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { ChildBackend, ChildSessionJournal, SessionInterruptedError } from "@usine/agents/runtime";
import { childSessionId } from "../src/attempt/sessions.ts";
import { CoordinatorRuntime } from "../src/coordinator/runtime.ts";
import { stubChildBackendLayer, StubChildren } from "../src/testing.ts";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { AttemptRequest, ParentReported, ResultRecorded } from "../src/attempt-runtime.ts";
import type { BrainSpec } from "@usine/core/agent/brain";
import {
  type AttemptContext,
  Complete,
  FIRST_ASSIGNMENT,
  REPLACEMENT_ASSIGNMENT,
} from "../src/attempt/coordinator/rules.ts";
import {
  AttemptJournal,
  EventSequence,
  JournalError,
  Settled,
} from "../src/coordinator/journal.ts";
import { outboxFor } from "../src/coordinator/outbox.ts";
import { RecordedDecision, WakeUp } from "../src/coordinator/wake-up.ts";
import {
  coordinated,
  coordinator,
  coordinatorWith,
  holdingTerminalLoad,
  interruptingTransition,
  orchestrator,
  stored,
  until,
} from "./coordinator-support.ts";
import {
  assertAdmitted,
  handlerSession,
  recordingSink,
  slowToInterrupt,
  sqliteJournal,
  temporaryDatabase,
  trace,
} from "./support.ts";

/**
 * Holds every `startDelegation` after completing `reached`, as a launch that waits through retry
 * delays does, so a process stop leaves only `Started` reserved.
 */
const holdingStartDelegation =
  (reached: Deferred.Deferred<void>) => (journal: Layer.Layer<AttemptJournal>) =>
    Layer.effect(
      AttemptJournal,
      Effect.gen(function* () {
        const inner = yield* AttemptJournal;
        return AttemptJournal.of({
          ...inner,
          startDelegation: () =>
            Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
        });
      }),
    ).pipe(Layer.provide(journal));

/**
 * Stops a launch before it returns, optionally after the harness saves its session reference.
 */
const hangingLaunches = (reached: Deferred.Deferred<void>, stage: "before-save" | "after-save") =>
  Layer.effectContext(
    Effect.gen(function* () {
      const backend = yield* ChildBackend;
      const children = yield* StubChildren;
      return Context.make(
        ChildBackend,
        ChildBackend.of({
          ...backend,
          launch: (request) =>
            Effect.gen(function* () {
              if (stage === "after-save") {
                const journal = yield* ChildSessionJournal.current;
                yield* journal.started(
                  HarnessSession.make({
                    id: HarnessSessionId.make("not-created-yet"),
                    cwd: request.cwd,
                  }),
                );
              }
              yield* Deferred.succeed(reached, undefined);
              return yield* Effect.never;
            }),
        }),
      ).pipe(Context.add(StubChildren, children));
    }),
  ).pipe(Layer.provide(stubChildBackendLayer));

/** Models a harness that cannot reopen the saved native conversation. */
const unavailableConversations = Layer.effectContext(
  Effect.gen(function* () {
    const backend = yield* ChildBackend;
    const children = yield* StubChildren;
    return Context.make(
      ChildBackend,
      ChildBackend.of({
        ...backend,
        launch: (request) =>
          Option.isSome(request.resume)
            ? Effect.fail(
                SessionInterruptedError.make({
                  sessionId: request.session.id,
                  message: "The saved native conversation is unavailable",
                }),
              )
            : backend.launch(request),
      }),
    ).pipe(Context.add(StubChildren, children));
  }),
).pipe(Layer.provide(stubChildBackendLayer));

/** Fails the first transition whose event has tag `tag` with `JournalError`. */
const failingTransitionOnce = (tag: string) => (journal: Layer.Layer<AttemptJournal>) =>
  Layer.effect(
    AttemptJournal,
    Effect.gen(function* () {
      const inner = yield* AttemptJournal;
      const isTagged = Schema.is(Schema.Struct({ _tag: Schema.Literal(tag) }));
      let failed = false;
      return AttemptJournal.of({
        ...inner,
        transition: (attemptId, expected, step) => {
          if (failed || !isTagged(step.event)) return inner.transition(attemptId, expected, step);
          failed = true;
          return Effect.fail(
            JournalError.make({
              operation: "commit an attempt journal transition",
              attemptId,
              cause: new Error("disk I/O error"),
            }),
          );
        },
      });
    }),
  ).pipe(Layer.provide(journal));

const failingLoads = (fails: Ref.Ref<boolean>) => (journal: Layer.Layer<AttemptJournal>) =>
  Layer.effect(
    AttemptJournal,
    Effect.gen(function* () {
      const inner = yield* AttemptJournal;
      return AttemptJournal.of({
        ...inner,
        load: (attemptId) =>
          Ref.get(fails).pipe(
            Effect.flatMap((failed) =>
              failed
                ? Effect.fail(
                    JournalError.make({
                      operation: "load an attempt journal",
                      attemptId,
                      cause: new Error("disk I/O error"),
                    }),
                  )
                : inner.load(attemptId),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(journal));

/** Holds the `decide` call for event `sequence` after completing `reached`, until `release` completes. */
const holdingDecide =
  (sequence: EventSequence, reached: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  (journal: Layer.Layer<AttemptJournal>) =>
    Layer.effect(
      AttemptJournal,
      Effect.gen(function* () {
        const inner = yield* AttemptJournal;
        return AttemptJournal.of({
          ...inner,
          decide: (attemptId, decided, decision) =>
            (decided === sequence
              ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void
            ).pipe(Effect.andThen(inner.decide(attemptId, decided, decision))),
        });
      }),
    ).pipe(Layer.provide(journal));

/** Holds each `settleOpen` after it commits, completing `settled`, until `resume` completes. */
const holdingSettleOpen =
  (settled: Deferred.Deferred<void>, resume: Deferred.Deferred<void>) =>
  (journal: Layer.Layer<AttemptJournal>) =>
    Layer.effect(
      AttemptJournal,
      Effect.gen(function* () {
        const inner = yield* AttemptJournal;
        return AttemptJournal.of({
          ...inner,
          settleOpen: (attemptId) =>
            inner
              .settleOpen(attemptId)
              .pipe(
                Effect.tap(() =>
                  Deferred.succeed(settled, undefined).pipe(Effect.andThen(Deferred.await(resume))),
                ),
              ),
        });
      }),
    ).pipe(Layer.provide(journal));

/**
 * Holds the first `settleDelegation` after it commits, completing `ended`, until `release`
 * completes. The coordinator makes that call after its child ends and before it reloads the journal
 * for the event's transition.
 */
const holdingSettleDelegation =
  (ended: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  (journal: Layer.Layer<AttemptJournal>) =>
    Layer.effect(
      AttemptJournal,
      Effect.gen(function* () {
        const inner = yield* AttemptJournal;
        let held = false;
        return AttemptJournal.of({
          ...inner,
          settleDelegation: (attemptId, number, outcome) =>
            inner.settleDelegation(attemptId, number, outcome).pipe(
              Effect.tap(() => {
                if (held) return Effect.void;
                held = true;
                return Deferred.succeed(ended, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                );
              }),
            ),
        });
      }),
    ).pipe(Layer.provide(journal));

/** Interrupts each `settle` and `settleOpen` once `stopped` holds, as a process stop does. */
const stoppingSettles = (stopped: () => boolean) => (journal: Layer.Layer<AttemptJournal>) =>
  Layer.effect(
    AttemptJournal,
    Effect.gen(function* () {
      const inner = yield* AttemptJournal;
      return AttemptJournal.of({
        ...inner,
        settle: (attemptId) =>
          Effect.suspend(() => (stopped() ? Effect.interrupt : inner.settle(attemptId))),
        settleOpen: (attemptId) =>
          Effect.suspend(() => (stopped() ? Effect.interrupt : inner.settleOpen(attemptId))),
      });
    }),
  ).pipe(Layer.provide(journal));

/** Fails each outbound envelope that `fails` matches, and records the others. */
const failingWhere = (
  sink: AttemptChannel.Sink,
  fails: (payload: AttemptChannel.OutboundPayload) => boolean,
): AttemptChannel.Sink => ({
  ...sink,
  append: (direction, envelope) =>
    envelope._tag === "OutboundEnvelope" && fails(envelope.payload)
      ? Effect.fail(InfraFailure.make({ message: "transcript unavailable", cause: "test" }))
      : sink.append(direction, envelope),
});

const unresponsive = (reason: string) =>
  AttemptChannel.WorkerUnresponsive.make({
    worker: WorkerName.make("local"),
    lastAnsweredAt: DateTime.makeUnsafe("2026-11-11T08:59:00Z"),
    reason,
  });

/** The reasons of the relayed `WorkerUnresponsive` notices, in order. */
const unresponsiveReasons = (envelopes: ReadonlyArray<AttemptChannel.OutboundEnvelope>) =>
  envelopes.flatMap(({ payload }) =>
    payload._tag === "WorkerUnresponsive" ? [payload.reason] : [],
  );

/** One creation or drop of an Attempt's in-process state, with the hubs left afterwards. */
interface HubChange {
  readonly change: "created" | "dropped";
  readonly attemptId: string;
  readonly hubs: number;
}

const decodeHubChange = Schema.decodeUnknownOption(
  Schema.Tuple([
    Schema.Literals([
      "Created the Attempt's in-process state",
      "Dropped the Attempt's in-process state",
    ]),
    Schema.Struct({ attemptId: Schema.String, hubs: Schema.Finite }),
  ]),
);

const tagged = Schema.decodeUnknownOption(Schema.Tuple([Schema.String, Schema.Unknown]));

/** Records the creations and drops of in-process state that the runtime logs, in order. */
const hubChanges = () => {
  const changes: Array<HubChange> = [];
  const logger = Logger.layer([
    Logger.make(({ message }) =>
      Option.match(decodeHubChange(message), {
        onNone: () => undefined,
        onSome: ([text, { attemptId, hubs }]) => {
          changes.push({
            change: text.startsWith("Created") ? "created" : "dropped",
            attemptId,
            hubs,
          });
        },
      }),
    ),
  ]);
  return { changes, logger };
};

const tagOf = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }));

/** A model handler's decision to complete the Attempt with `message`. */
const decides = (message: string, handler: Exclude<RecordedDecision["handler"], "rule">) =>
  Effect.succeedSome(
    RecordedDecision.make({
      decision: Complete.make({ message }),
      handler,
      session: Option.some(handlerSession),
    }),
  );

const decodeChildReport = Schema.decodeUnknownOption(
  Schema.TaggedStruct("ChildReported", { report: Schema.String }),
);

/** The report text each reserved child report records, with its marker from `@usine/agents`. */
const reservedReports = {
  blocked: `${BLOCKED_MARKER}\nThe repository is archived.`,
  question: `${QUESTION_MARKER}\nWhich base branch?`,
  failed: `${FAILED_MARKER}\nThe harness stopped.`,
} satisfies Record<string, string>;

describe("event-driven coordinator runtime", () => {
  it.live("completes an Attempt with its child's report and relays Started without a parent", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/completes");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      yield* child.reply("Opened #12.");
      const report = yield* Fiber.join(execution);
      const live = yield* process.attempts.isLive(attemptId);
      const reported = yield* process.attempts.finished(attemptId);
      const result = StepCompletion.fromResult(
        StepResult.make({ message: report.message, facts: [] }),
      );
      yield* process.attempts.recordResult(attemptId, result);
      const harvested = yield* process.attempts.finished(attemptId);
      const kept = yield* process.attempts.request(attemptId);
      yield* process.stop;
      const snapshot = yield* stored(database, attemptId);

      assert.include(child.request.prompt, FIRST_ASSIGNMENT);
      assert.include(child.request.prompt, request.spec.task);
      assert.strictEqual(report.message, "Opened #12.");
      assert.isFalse(live);
      assert.deepStrictEqual(reported, Option.some(ParentReported.make({ report })));
      assert.deepStrictEqual(harvested, Option.some(ResultRecorded.make({ result })));
      assert.deepStrictEqual(
        Option.map(kept, ({ spec }) => spec.coordinator),
        Option.some("events"),
      );
      assert.deepStrictEqual(
        Option.map(snapshot, ({ delegations }) => delegations.map(({ number }) => number)),
        Option.some([1]),
      );
      const outbound = recording.outbound();
      assertAdmitted(attemptId, outbound);
      assert.deepStrictEqual(trace(outbound), [
        "Started",
        "child.SessionStarted",
        "child.TextOutput",
        "child.SessionFinished",
        "Final",
      ]);
      const [started] = outbound;
      assert.isTrue(
        started?.payload._tag === "Started" && Option.isNone(started.payload.parentModel),
      );
    }).pipe(Effect.scoped),
  );

  it.live("fails with each reserved report, a capacity refusal, and a transport loss", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const resetsAt = DateTime.makeUnsafe("2026-11-11T18:00:00Z");
      const cases = [
        ["blocked", BlockedFailure.make({ message: "The repository is archived." })],
        ["question", QuestionFailure.make({ question: "Which base branch?" })],
        ["failed", AgentFailure.make({ message: "The harness stopped." })],
        [
          "capacity",
          ProviderCapacityFailure.make({
            message: "Usage limit reached",
            resetsAt: Option.some(resetsAt),
          }),
        ],
        ["infra", InfraFailure.make({ message: "ssh: closed", cause: "ssh: closed" })],
      ] as const;
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      for (const [kind, expected] of cases) {
        const request = coordinated(`coordinator/fails/${kind}`);
        const recording = recordingSink();
        const execution = yield* process.execute(request, recording.sink);
        const child = yield* process.nextChild;
        if (kind === "blocked") yield* child.block("The repository is archived.");
        if (kind === "question") yield* child.ask("Which base branch?");
        if (kind === "failed") yield* child.fail("The harness stopped.");
        if (kind === "capacity") yield* child.limit("Usage limit reached", resetsAt);
        if (kind === "infra") yield* child.crash("ssh: closed");
        const failure = yield* Fiber.join(execution).pipe(Effect.flip);
        const finished = yield* process.attempts.finished(request.spec.attemptId);

        assert.strictEqual(failure._tag, expected._tag, kind);
        assert.strictEqual(failure.message, expected.message, kind);
        if (failure._tag === "ProviderCapacityFailure")
          assert.deepStrictEqual(failure.resetsAt, Option.some(resetsAt));
        assert.deepStrictEqual(
          Option.map(finished, ({ _tag }) => _tag),
          Option.some("ParentFailed"),
          kind,
        );
        assertAdmitted(request.spec.attemptId, recording.outbound());
        assert.strictEqual(trace(recording.outbound()).at(-1), "Failed", kind);
        const journal = yield* stored(database, request.spec.attemptId);
        assert.deepStrictEqual(
          Option.map(journal, ({ events }) =>
            events.flatMap(({ event }) =>
              Option.match(decodeChildReport(event), {
                onNone: () => [],
                onSome: ({ report }) => [report],
              }),
            ),
          ),
          Option.some(
            kind === "blocked" || kind === "question" || kind === "failed"
              ? [reservedReports[kind]]
              : [],
          ),
          kind,
        );
      }
      yield* process.stop;
    }).pipe(Effect.scoped),
  );

  it.live(
    "cancels a running Attempt: its child stops, Interrupted is relayed, and it settles",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated("coordinator/cancel");
        const attemptId = request.spec.attemptId;
        const recording = recordingSink();
        const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        const execution = yield* process.execute(request, slowToInterrupt(recording.sink));
        const child = yield* process.nextChild;
        yield* process.attempts.cancel(attemptId);
        // `cancel` returns only after the child stopped and the channel ended.
        const stoppedOnReturn = yield* child.interrupted.pipe(Effect.timeoutOption(0));
        const lastOnReturn = trace(recording.outbound()).at(-1);
        const failure = yield* Fiber.join(execution).pipe(Effect.flip);
        const live = yield* process.attempts.isLive(attemptId);
        const finished = yield* process.attempts.finished(attemptId);
        yield* process.stop;

        assert.isTrue(Option.isSome(stoppedOnReturn));
        assert.strictEqual(lastOnReturn, "Interrupted");
        assert.strictEqual(failure._tag, "AgentFailure");
        assert.isFalse(live);
        assert.isTrue(Option.isNone(finished));
        assertAdmitted(attemptId, recording.outbound());
        assert.strictEqual(trace(recording.outbound()).at(-1), "Interrupted");
      }).pipe(Effect.scoped),
  );

  it.live(
    "stops a canceled Attempt's child without a resume when the cancel escalates to an interrupt",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated("coordinator/cancel-escalates");
        const recording = recordingSink();
        const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        const execution = yield* process.execute(request, recording.sink);
        const child = yield* process.nextChild;
        yield* child.stall;
        // As the executor does: cancel, wait a bounded time, then interrupt `execute`.
        const canceling = yield* process.attempts
          .cancel(request.spec.attemptId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* child.interrupted;
        const interrupted = yield* Fiber.interrupt(execution).pipe(
          Effect.timeoutOption("2 seconds"),
        );
        const stoppingOnClose = yield* child.closed;
        yield* Fiber.join(canceling);
        const live = yield* process.attempts.isLive(request.spec.attemptId);
        yield* process.stop;

        assert(Option.isSome(interrupted), "the interrupt waited for the child to stop");
        assert.isFalse(stoppingOnClose);
        assert.isFalse(live);
      }).pipe(Effect.scoped),
  );

  it.live("relays Worker notices from Started until the outcome", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/notices");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* process.attempts.notify(attemptId, unresponsive("before start"));
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      yield* process.attempts.notify(attemptId, unresponsive("while working"));
      yield* child.reply("Done.");
      yield* Fiber.join(execution);
      yield* process.attempts.notify(attemptId, unresponsive("after the end"));
      yield* process.stop;

      const outbound = recording.outbound();
      assertAdmitted(attemptId, outbound);
      assert.deepStrictEqual(unresponsiveReasons(outbound), ["before start", "while working"]);
      assert.deepStrictEqual(trace(outbound).slice(0, 2), ["Started", "WorkerUnresponsive"]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps a Worker notice that arrives while the coordinator decides its start", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/notice-while-deciding");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Holds the decision for `AttemptStarted`: the call is attached, and `Started` isn't
      // reserved yet.
      const holding = Layer.succeed(
        WakeUp,
        WakeUp.of({
          handle: (event) =>
            event._tag === "AttemptStarted"
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(Option.none()),
                )
              : Effect.succeedNone,
        }),
      );
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinatorWith(holding)));
      const execution = yield* process.execute(request, recording.sink);
      yield* Deferred.await(reached);
      const attached = yield* process.attempts.attached(attemptId).pipe(Effect.timeoutOption(0));
      yield* process.attempts.notify(attemptId, unresponsive("while deciding"));
      const relayedWhileDeciding = recording.outbound().length;
      yield* Deferred.succeed(release, undefined);
      const child = yield* process.nextChild;
      yield* child.reply("Done.");
      yield* Fiber.join(execution);
      yield* process.stop;

      const outbound = recording.outbound();
      assert.isTrue(Option.isSome(attached));
      assert.strictEqual(relayedWhileDeciding, 0);
      assertAdmitted(attemptId, outbound);
      assert.deepStrictEqual(trace(outbound).slice(0, 2), ["Started", "WorkerUnresponsive"]);
      assert.deepStrictEqual(unresponsiveReasons(outbound), ["while deciding"]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps the Worker notices for the next execute call after Started fails to commit", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/notice-after-failed-start");
      const attemptId = request.spec.attemptId;
      const process = yield* orchestrator(
        sqliteJournal(database).pipe(failingTransitionOnce("AttemptStarted"), coordinator),
      );
      yield* process.attempts.notify(attemptId, unresponsive("before start"));
      const failure = yield* process.attempts
        .execute(request, recordingSink().sink)
        .pipe(Effect.flip);
      const recording = recordingSink();
      const execution = yield* process.execute(request, recording.sink);
      yield* (yield* process.nextChild).reply("Done.");
      yield* Fiber.join(execution);
      yield* process.stop;

      const outbound = recording.outbound();
      assert.strictEqual(failure._tag, "InfraFailure");
      assert.include(failure.message, "disk I/O error");
      assertAdmitted(attemptId, outbound);
      assert.deepStrictEqual(trace(outbound).slice(0, 2), ["Started", "WorkerUnresponsive"]);
      assert.deepStrictEqual(unresponsiveReasons(outbound), ["before start"]);
    }).pipe(Effect.scoped),
  );

  it.live("forgets committed Worker notices when an execute call resumes in the same process", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/notice-after-committed-start");
      const attemptId = request.spec.attemptId;
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const first = recordingSink();
      yield* process.attempts.notify(attemptId, unresponsive("before start"));
      const execution = yield* process.execute(request, first.sink);
      yield* process.nextChild;
      yield* Fiber.interrupt(execution);
      const live = yield* process.attempts.isLive(attemptId);

      assert.isTrue(live);
      assert.deepStrictEqual(trace(first.outbound()).slice(0, 2), [
        "Started",
        "WorkerUnresponsive",
      ]);
      assert.deepStrictEqual(unresponsiveReasons(first.outbound()), ["before start"]);

      const second = recordingSink();
      const resumed = yield* process.execute(request, second.sink);
      yield* (yield* process.nextChild).reply("Done.");
      yield* Fiber.join(resumed);
      yield* process.stop;

      assert.deepStrictEqual(unresponsiveReasons(second.outbound()), []);
      assert.strictEqual(trace(second.outbound()).at(-1), "Final");
      assertAdmitted(attemptId, [...first.outbound(), ...second.outbound()]);
    }).pipe(Effect.scoped),
  );

  it.live("hands WakeUp the end of the child's output and the ended delegation", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/wake-up-context");
      const recording = recordingSink();
      const received: Array<AttemptContext> = [];
      const recordingWakeUp = Layer.succeed(
        WakeUp,
        WakeUp.of({
          handle: (_event, context) =>
            Effect.sync(() => {
              received.push(context);
            }).pipe(Effect.as(Option.none())),
        }),
      );
      const process = yield* orchestrator(
        sqliteJournal(database).pipe(coordinatorWith(recordingWakeUp)),
      );
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      // More than the 50,000 characters the delegation retains. Characters 48,000 to 50,000 differ
      // from the last 2,000.
      const written = ["s".repeat(30_000), "m".repeat(28_000), "e".repeat(2_000)];
      for (const text of written)
        yield* child.emit(TextOutput.make({ session: child.request.session, text }));
      // The stub child also writes its report as output.
      yield* child.reply("Opened #12.");
      yield* Fiber.join(execution);
      yield* process.stop;

      const reported = received.find(({ event }) => event._tag === "ChildReported");
      assert.deepStrictEqual(
        received.map(({ event }) => event._tag),
        ["AttemptStarted", "ChildReported"],
      );
      assert(reported !== undefined);
      // The delegation retains each text output with a line break.
      const all = [...written, "Opened #12."].map((text) => `${text}\n`).join("");
      assert.strictEqual(reported.output, all.slice(-2_000));
      assert.deepStrictEqual(
        reported.delegations.map(({ child, status }) => [Number(child), status]),
        [[1, "ended"]],
      );
    }).pipe(Effect.scoped),
  );

  it.live("hands WakeUp the attempt ID, event sequence, agent brain, and attached request", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/wake-up-attempt");
      const seen: Array<{
        readonly event: string;
        readonly attemptId: AttemptId;
        readonly sequence: number;
        readonly brain: BrainSpec;
        readonly request: AttemptRequest;
      }> = [];
      // Reads what a model handler needs to open a session on the attempt's worker, and opens none.
      const reading = Layer.succeed(
        WakeUp,
        WakeUp.of({
          handle: (event, _context, attempt) =>
            attempt.request.pipe(
              Effect.map((attached) => {
                seen.push({
                  event: event._tag,
                  attemptId: attempt.attemptId,
                  sequence: attempt.sequence,
                  brain: attempt.spec.agent.brain,
                  request: attached,
                });
              }),
              Effect.as(Option.none()),
            ),
        }),
      );
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinatorWith(reading)));
      const execution = yield* process.execute(request, recordingSink().sink);
      yield* (yield* process.nextChild).reply("Opened #12.");
      yield* Fiber.join(execution);
      yield* process.stop;

      assert.deepStrictEqual(
        seen.map(({ event, attemptId, sequence, brain }) => ({
          event,
          attemptId,
          sequence,
          brain,
        })),
        [
          {
            event: "AttemptStarted",
            attemptId: request.spec.attemptId,
            sequence: 1,
            brain: request.spec.agent.brain,
          },
          {
            event: "ChildReported",
            attemptId: request.spec.attemptId,
            sequence: 2,
            brain: request.spec.agent.brain,
          },
        ],
      );
      for (const { request: attached } of seen) assert.strictEqual(attached, request);
    }).pipe(Effect.scoped),
  );

  it.live("drops each Attempt's in-process state once it finishes, without a settle", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const completed = coordinated("coordinator/state-completed");
      const blocked = coordinated("coordinator/state-blocked");
      const canceled = coordinated("coordinator/state-canceled");
      const { changes, logger } = hubChanges();
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const { liveAfterBlock, refused } = yield* Effect.gen(function* () {
        // Notices before the start keep the Attempt's state until it finishes.
        yield* process.attempts.notify(completed.spec.attemptId, unresponsive("before start"));
        const execution = yield* process.execute(completed, recordingSink().sink);
        yield* (yield* process.nextChild).reply("Opened #12.");
        const report = yield* Fiber.join(execution);
        // The executor records the harvested result and calls neither cancel nor settle.
        yield* process.attempts.recordResult(
          completed.spec.attemptId,
          StepCompletion.fromResult(StepResult.make({ message: report.message, facts: [] })),
        );

        const failing = yield* process.execute(blocked, recordingSink().sink);
        yield* (yield* process.nextChild).block("The repository is archived.");
        yield* Fiber.await(failing);
        // The executor stops here: an Attempt that isn't live gets no settle.
        const liveAfterBlock = yield* process.attempts.isLive(blocked.spec.attemptId);

        const running = yield* process.execute(canceled, recordingSink().sink);
        yield* process.nextChild;
        yield* process.attempts.cancel(canceled.spec.attemptId);
        yield* Fiber.await(running);

        // A late notice, wait, or input doesn't bring a finished Attempt's state back.
        for (const { spec } of [completed, blocked, canceled]) {
          yield* process.attempts.notify(spec.attemptId, unresponsive("after the end"));
          const attached = yield* process.attempts
            .attached(spec.attemptId)
            .pipe(Effect.timeoutOption("50 millis"));
          assert.isTrue(Option.isNone(attached), "a finished Attempt has no attached execute call");
        }
        const refused = yield* process.attempts
          .intervene(
            completed.spec.attemptId,
            AttemptChannel.Intervention.make({
              target: AttemptChannel.ParentTarget.make(),
              operator: "octocat",
              action: AttemptChannel.Release.make(),
            }),
          )
          .pipe(Effect.flip);
        return { liveAfterBlock, refused };
      }).pipe(Effect.provide(logger));
      yield* process.stop;

      assert.isFalse(liveAfterBlock);
      assert.deepStrictEqual(
        changes,
        [completed, blocked, canceled].flatMap(({ spec }) => [
          { change: "created", attemptId: spec.attemptId, hubs: 1 },
          { change: "dropped", attemptId: spec.attemptId, hubs: 0 },
        ]),
      );
      assert.strictEqual(refused.message, "This attempt has no live channel");
    }).pipe(Effect.scoped),
  );

  it.live("relays a pre-start Worker notice after the journal becomes readable again", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/notice-unreadable-journal");
      const attemptId = request.spec.attemptId;
      const fails = yield* Ref.make(true);
      const logged: Array<unknown> = [];
      const logger = Logger.layer([Logger.make(({ message }) => logged.push(message))]);
      const process = yield* orchestrator(
        sqliteJournal(database).pipe(failingLoads(fails), coordinator),
      );
      const recording = recordingSink();
      yield* process.attempts
        .notify(attemptId, unresponsive("journal unavailable before start"))
        .pipe(Effect.provide(logger));
      yield* Ref.set(fails, false);
      const execution = yield* process.execute(request, recording.sink);
      yield* (yield* process.nextChild).reply("Done.");
      yield* Fiber.join(execution);
      yield* process.stop;

      assert.deepStrictEqual(unresponsiveReasons(recording.outbound()), [
        "journal unavailable before start",
      ]);
      assert.strictEqual(recording.outbound()[0]?.payload._tag, "Started");
      assert.deepInclude(logged, [
        "Could not read whether the Attempt is finished; keeping its state",
        { attemptId, message: "Could not load an attempt journal: disk I/O error" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps a canceled Attempt's state when its journal cannot be read", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/cancel-unreadable-journal");
      const attemptId = request.spec.attemptId;
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recordingSink().sink);
      yield* first.nextChild;
      yield* first.stop;

      const fails = yield* Ref.make(false);
      const logged: Array<unknown> = [];
      const logger = Logger.layer([Logger.make(({ message }) => logged.push(message))]);
      const second = yield* orchestrator(
        sqliteJournal(database).pipe(failingLoads(fails), coordinator),
      );
      yield* Effect.gen(function* () {
        yield* second.attempts.notify(attemptId, unresponsive("after restart"));
        yield* Ref.set(fails, true);
        yield* second.attempts.cancel(attemptId);
        assert.deepInclude(logged, [
          "Could not read whether the Attempt is finished; keeping its state",
          { attemptId, message: "Could not load an attempt journal: disk I/O error" },
        ]);
        assert.deepStrictEqual(
          logged.flatMap((message) => Option.toArray(decodeHubChange(message))),
          [["Created the Attempt's in-process state", { attemptId, hubs: 1 }]],
        );
        yield* Ref.set(fails, false);
        const liveAfterCancel = yield* second.attempts.isLive(attemptId);
        assert.isFalse(liveAfterCancel);
        yield* second.attempts.settle(attemptId);
        assert.deepStrictEqual(
          logged.flatMap((message) => Option.toArray(decodeHubChange(message))),
          [
            ["Created the Attempt's in-process state", { attemptId, hubs: 1 }],
            ["Dropped the Attempt's in-process state", { attemptId, hubs: 0 }],
          ],
        );
      }).pipe(Effect.provide(logger));
      yield* second.stop;
    }).pipe(Effect.scoped),
  );

  it.live("keeps an Attempt's in-process state while an execute call relays it", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/state-relayed");
      const attemptId = request.spec.attemptId;
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { changes, logger } = hubChanges();
      const process = yield* orchestrator(
        sqliteJournal(database).pipe(holdingTerminalLoad(reached, release), coordinator),
      );
      const whileRelayed = yield* Effect.gen(function* () {
        const execution = yield* process.execute(request, recordingSink().sink);
        yield* (yield* process.nextChild).reply("Done.");
        // `Final` is delivered, and the `execute` call is still attached.
        yield* Deferred.await(reached);
        yield* process.attempts.settle(attemptId);
        const whileRelayed = [...changes];
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(execution);
        return whileRelayed;
      }).pipe(Effect.provide(logger));
      yield* process.stop;

      assert.deepStrictEqual(whileRelayed, [{ change: "created", attemptId, hubs: 1 }]);
      assert.deepStrictEqual(changes, [
        { change: "created", attemptId, hubs: 1 },
        { change: "dropped", attemptId, hubs: 0 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("drops a canceled Attempt's state when the cancel outlasts its grace", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/state-cancel-past-grace");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      // The transcript is slow to take `Interrupted`, so the cancel can't finish within its grace.
      const slow: AttemptChannel.Sink = {
        ...recording.sink,
        append: (direction, envelope) =>
          envelope._tag === "OutboundEnvelope" && envelope.payload._tag === "Interrupted"
            ? Effect.sleep("2 seconds").pipe(
                Effect.andThen(recording.sink.append(direction, envelope)),
              )
            : recording.sink.append(direction, envelope),
      };
      const { changes, logger } = hubChanges();
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const { canceled, live } = yield* Effect.gen(function* () {
        const execution = yield* process.execute(request, slow);
        yield* process.nextChild;
        // As the executor's stop does: cancel within a grace, then interrupt `execute`.
        const canceled = yield* process.attempts
          .cancel(attemptId)
          .pipe(Effect.timeoutOption("200 millis"));
        yield* Fiber.interrupt(execution);
        // The executor then finds the Attempt not live and calls neither cancel nor settle.
        const live = yield* process.attempts.isLive(attemptId);
        return { canceled, live };
      }).pipe(Effect.provide(logger));
      const journal = yield* stored(database, attemptId);
      yield* process.stop;

      assert.isTrue(Option.isNone(canceled));
      assert.isFalse(live);
      assert.deepStrictEqual(
        Option.map(journal, ({ status }) => status._tag),
        Option.some("Settled"),
      );
      assert.deepStrictEqual(changes, [
        { change: "created", attemptId, hubs: 1 },
        { change: "dropped", attemptId, hubs: 0 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("drops a Terminal Attempt's state on settle after its sink failed on Final", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/state-final-failed");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const { changes, logger } = hubChanges();
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const { failure, live, afterCancel } = yield* Effect.gen(function* () {
        const execution = yield* process.execute(
          request,
          failingWhere(recording.sink, ({ _tag }) => _tag === "Final"),
        );
        yield* (yield* process.nextChild).reply("Done.");
        const failure = yield* Fiber.join(execution).pipe(Effect.flip);
        // As the executor's stop does: the undelivered `Final` keeps the Attempt live, so it
        // cancels, then settles.
        const live = yield* process.attempts.isLive(attemptId);
        yield* process.attempts.cancel(attemptId);
        const afterCancel = [...changes];
        yield* process.attempts.settle(attemptId);
        return { failure, live, afterCancel };
      }).pipe(Effect.provide(logger));
      yield* process.stop;

      assert.strictEqual(failure._tag, "InfraFailure");
      assert.isTrue(live);
      assert.deepStrictEqual(afterCancel, [{ change: "created", attemptId, hubs: 1 }]);
      assert.deepStrictEqual(changes, [
        { change: "created", attemptId, hubs: 1 },
        { change: "dropped", attemptId, hubs: 0 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("relays a second execute call once the first detaches, with the same report", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/second-execute");
      const first = recordingSink();
      const second = recordingSink();
      const logged: Array<string> = [];
      const logger = Logger.layer([
        Logger.make(({ message }) =>
          Option.match(tagged(message), {
            onNone: () => undefined,
            onSome: ([text]) => {
              logged.push(text);
            },
          }),
        ),
      ]);
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const { firstReport, secondReport, waiting } = yield* Effect.gen(function* () {
        const firstCall = yield* process.execute(request, first.sink);
        const child = yield* process.nextChild;
        const secondCall = yield* process.execute(request, second.sink);
        const waiting = yield* Fiber.join(secondCall).pipe(Effect.timeoutOption("200 millis"));
        yield* child.reply("Done.");
        return {
          firstReport: yield* Fiber.join(firstCall),
          secondReport: yield* Fiber.join(secondCall),
          waiting,
        };
      }).pipe(Effect.provide(logger));
      yield* process.stop;

      assert.isTrue(Option.isNone(waiting));
      assert.strictEqual(firstReport.message, "Done.");
      assert.deepStrictEqual(secondReport, firstReport);
      assert.strictEqual(trace(first.outbound()).at(-1), "Final");
      assert.deepStrictEqual(second.outbound(), []);
      // The hub stays while the second call waits, and the second call relays it before the drop.
      assert.deepStrictEqual(
        logged.filter((text) =>
          [
            "Created the Attempt's in-process state",
            "Relaying the Attempt's channel",
            "Dropped the Attempt's in-process state",
          ].includes(text),
        ),
        [
          "Created the Attempt's in-process state",
          "Relaying the Attempt's channel",
          "Relaying the Attempt's channel",
          "Dropped the Attempt's in-process state",
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.live("cancels an Attempt whose execute call already returned, without waiting", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/cancel-after-execute");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      yield* child.reply("Opened #12.");
      yield* Fiber.join(execution);
      const relayed = recording.outbound().length;
      // A person cancels the Run while the executor harvests the finished Attempt.
      const canceled = yield* process.attempts
        .cancel(attemptId)
        .pipe(Effect.timeoutOption("3 seconds"));
      const live = yield* process.attempts.isLive(attemptId);
      yield* process.stop;

      assert.isTrue(Option.isSome(canceled));
      assert.isFalse(live);
      assert.strictEqual(recording.outbound().length, relayed);
      assert.strictEqual(trace(recording.outbound()).at(-1), "Final");
    }).pipe(Effect.scoped),
  );

  it.live("drops Worker notices and relays no Interrupted after the terminal envelope", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/after-final");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const process = yield* orchestrator(
        sqliteJournal(database).pipe(holdingTerminalLoad(reached, release), coordinator),
      );
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      yield* child.reply("Done.");
      // `Final` is delivered, and the `execute` call is still attached.
      yield* Deferred.await(reached);
      yield* process.attempts.notify(attemptId, unresponsive("after Final"));
      const logged: Array<string> = [];
      const canceling = yield* Effect.forkChild(
        process.attempts
          .cancel(attemptId)
          .pipe(
            Effect.provide(
              Logger.layer([Logger.make(({ message }) => logged.push(String(message)))]),
            ),
          ),
      );
      // The cancel signals the attached call right after this log, without yielding.
      yield* until(() =>
        logged.some((entry) => entry.includes("Canceling the coordinated Attempt")),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(canceling);
      yield* Fiber.await(execution);
      yield* process.stop;

      const outbound = recording.outbound();
      assertAdmitted(attemptId, outbound);
      assert.strictEqual(trace(outbound).at(-1), "Final");
      assert.deepStrictEqual(unresponsiveReasons(outbound), []);
    }).pipe(Effect.scoped),
  );

  it.live("commits a cancel before a held decision, which then commits no outcome", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/cancel-during-decision");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Holds the record of the decision for the child's report: the handler has returned, so the
      // cancel no longer interrupts it.
      const holding = holdingDecide(EventSequence.make(2), reached, release);
      const logged: Array<string> = [];
      const logger = Logger.layer([Logger.make(({ message }) => logged.push(String(message)))]);
      const process = yield* orchestrator(sqliteJournal(database).pipe(holding, coordinator));
      const execution = yield* Effect.forkChild(
        process.attempts.execute(request, recording.sink).pipe(Effect.provide(logger)),
      );
      yield* (yield* process.nextChild).reply("Opened #12.");
      yield* Deferred.await(reached);
      const canceling = yield* Effect.forkChild(
        process.attempts.cancel(attemptId).pipe(Effect.provide(logger)),
      );
      // `cancel` has settled the `Open` journal and signals the attached call.
      yield* until(() =>
        logged.some((entry) => entry.includes("Canceling the coordinated Attempt")),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(canceling);
      const failure = yield* Fiber.join(execution).pipe(Effect.flip);
      const live = yield* process.attempts.isLive(attemptId);
      const finished = yield* process.attempts.finished(attemptId);
      yield* process.stop;
      const journal = yield* stored(database, attemptId);

      assert.strictEqual(failure._tag, "AgentFailure");
      assert.isFalse(live);
      assert.isTrue(Option.isNone(finished));
      assert.deepStrictEqual(
        Option.map(journal, ({ status, events }) => ({
          status: status._tag,
          events: events.length,
        })),
        // Only `AttemptStarted` committed; the held decision's transition found the journal settled.
        Option.some({ status: "Settled", events: 1 }),
      );
      assert.isTrue(
        logged.some((entry) =>
          entry.includes("The cancel settled the journal before this transition; it stops"),
        ),
      );
      assert.isFalse(logged.some((entry) => entry.includes("failed while it stopped")));
      assertAdmitted(attemptId, recording.outbound());
      assert.isFalse(trace(recording.outbound()).includes("Final"));
      assert.strictEqual(trace(recording.outbound()).at(-1), "Interrupted");
    }).pipe(Effect.scoped),
  );

  it.live("interrupts a slow handler when the Attempt is canceled, and commits no outcome", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/cancel-slow-handler");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const reached = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      // Decides the child's report only after a long model call, which the cancel interrupts.
      const slow = Layer.succeed(
        WakeUp,
        WakeUp.of({
          handle: (event) =>
            event._tag === "ChildReported"
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Effect.sleep("1 hour")),
                  Effect.andThen(decides("Decided after an hour.", "session")),
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                )
              : Effect.succeedNone,
        }),
      );
      const logged: Array<string> = [];
      const logger = Logger.layer([Logger.make(({ message }) => logged.push(String(message)))]);
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinatorWith(slow)));
      const execution = yield* Effect.forkChild(
        process.attempts.execute(request, recording.sink).pipe(Effect.provide(logger)),
      );
      yield* (yield* process.nextChild).reply("Opened #12.");
      yield* Deferred.await(reached);
      yield* process.attempts.cancel(attemptId);
      const failure = yield* Fiber.join(execution).pipe(Effect.flip);
      const handlerInterrupted = yield* Deferred.isDone(interrupted);
      yield* process.stop;
      const journal = yield* stored(database, attemptId);

      assert.strictEqual(failure._tag, "AgentFailure");
      assert.isTrue(handlerInterrupted);
      assert.isTrue(
        logged.some((entry) => entry.includes("The cancel interrupted the event's handler")),
      );
      assert.deepStrictEqual(
        Option.map(journal, ({ status, events, pendingDecision }) => ({
          status: status._tag,
          events: events.length,
          pending: Option.isSome(pendingDecision),
        })),
        Option.some({ status: "Settled", events: 1, pending: false }),
      );
      assert.isFalse(trace(recording.outbound()).includes("Final"));
      assert.strictEqual(trace(recording.outbound()).at(-1), "Interrupted");
    }).pipe(Effect.scoped),
  );

  it.live(
    "relays Interrupted when the coordinator finds the journal settled before the cancel signals",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated("coordinator/settled-before-signal");
        const attemptId = request.spec.attemptId;
        const recording = recordingSink();
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const holding = Layer.succeed(
          WakeUp,
          WakeUp.of({
            handle: (event) =>
              event._tag === "ChildReported"
                ? Deferred.succeed(reached, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(Option.none()),
                  )
                : Effect.succeedNone,
          }),
        );
        const process = yield* orchestrator(
          sqliteJournal(database).pipe(
            holdingSettleOpen(settled, resume),
            coordinatorWith(holding),
          ),
        );
        const execution = yield* process.execute(request, recording.sink);
        yield* (yield* process.nextChild).reply("Opened #12.");
        yield* Deferred.await(reached);
        const canceling = yield* Effect.forkChild(process.attempts.cancel(attemptId));
        // The journal is settled, and the cancel hasn't signaled the attached call yet.
        yield* Deferred.await(settled);
        yield* Deferred.succeed(release, undefined);
        const failure = yield* Fiber.join(execution).pipe(Effect.flip);
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(canceling);
        const live = yield* process.attempts.isLive(attemptId);
        yield* process.stop;

        assert.strictEqual(failure._tag, "AgentFailure");
        assert.isFalse(live);
        assertAdmitted(attemptId, recording.outbound());
        assert.isFalse(trace(recording.outbound()).includes("Final"));
        assert.strictEqual(trace(recording.outbound()).at(-1), "Interrupted");
      }).pipe(Effect.scoped),
  );

  for (const signal of ["sent", "held"] as const)
    it.live(
      `stops the child's event when a cancel settles the journal as the child ends, with the signal ${signal}`,
      () =>
        Effect.gen(function* () {
          const database = yield* temporaryDatabase;
          const request = coordinated(`coordinator/cancel-as-child-ends-${signal}`);
          const attemptId = request.spec.attemptId;
          const recording = recordingSink();
          const ended = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const settled = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const logged: Array<string> = [];
          const logger = Logger.layer([Logger.make(({ message }) => logged.push(String(message)))]);
          const journal = sqliteJournal(database).pipe(holdingSettleDelegation(ended, release));
          const process = yield* orchestrator(
            (signal === "held" ? journal.pipe(holdingSettleOpen(settled, resume)) : journal).pipe(
              coordinator,
            ),
          );
          const execution = yield* Effect.forkChild(
            process.attempts.execute(request, recording.sink).pipe(Effect.provide(logger)),
          );
          yield* (yield* process.nextChild).reply("Opened #12.");
          // The delegation recorded the child's report; the event's transition hasn't loaded yet.
          yield* Deferred.await(ended);
          const canceling = yield* Effect.forkChild(
            process.attempts.cancel(attemptId).pipe(Effect.provide(logger)),
          );
          if (signal === "held") yield* Deferred.await(settled);
          else
            yield* until(() =>
              logged.some((entry) => entry.includes("Canceling the coordinated Attempt")),
            );
          yield* Deferred.succeed(release, undefined);
          const failure = yield* Fiber.join(execution).pipe(Effect.flip);
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(canceling);
          const live = yield* process.attempts.isLive(attemptId);
          yield* process.stop;
          const stopped = yield* stored(database, attemptId);

          assert.strictEqual(failure._tag, "AgentFailure");
          assert.isFalse(live);
          assert(Option.isSome(stopped));
          assert.strictEqual(stopped.value.status._tag, "Settled");
          assert.isTrue(Option.isNone(stopped.value.pendingDecision));
          assert.strictEqual(stopped.value.events.length, 1);
          assert.isTrue(
            logged.some((entry) =>
              entry.includes("The journal was settled while the child ended; the event stops"),
            ),
          );
          assert.isFalse(logged.some((entry) => entry.includes("failed while it stopped")));
          assertAdmitted(attemptId, recording.outbound());
          assert.isFalse(trace(recording.outbound()).includes("Final"));
          assert.strictEqual(trace(recording.outbound()).at(-1), "Interrupted");
        }).pipe(Effect.scoped),
    );

  it.live(
    "leaves a committed outcome live when cancel finds its terminal envelope undelivered",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated("coordinator/cancel-after-failed-final");
        const attemptId = request.spec.attemptId;
        const recording = recordingSink();
        // Fails each terminal envelope, as a drained Worker's transcript does.
        const sink = failingWhere(recording.sink, (payload) => payload._tag === "Final");
        const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        const execution = yield* process.execute(request, sink);
        yield* (yield* process.nextChild).reply("Opened #12.");
        yield* Fiber.await(execution);
        const logged: Array<string> = [];
        yield* process.attempts
          .cancel(attemptId)
          .pipe(
            Effect.provide(
              Logger.layer([Logger.make(({ message }) => logged.push(String(message)))]),
            ),
          );
        const live = yield* process.attempts.isLive(attemptId);
        const finished = yield* process.attempts.finished(attemptId);
        yield* process.stop;
        const journal = yield* stored(database, attemptId);

        assert.isTrue(live);
        assert.isTrue(Option.isNone(finished));
        assert(Option.isSome(journal));
        assert.strictEqual(journal.value.status._tag, "Terminal");
        assert.deepStrictEqual(
          journal.value.outbox.map(({ payload }) => payload._tag),
          ["Final"],
        );
        assert.isTrue(
          logged.some((entry) =>
            entry.includes("The canceled Attempt has an outcome; its caller decides to settle it"),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "fails the Attempt when relaying its child's activity fails, before the child replies",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated("coordinator/activity-relay-fails");
        const recording = recordingSink();
        const sink = failingWhere(
          recording.sink,
          (payload) => payload._tag === "SessionEvent" && payload.event._tag === "TextOutput",
        );
        const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        const execution = yield* process.execute(request, sink);
        const child = yield* process.nextChild;
        yield* child.emit(TextOutput.make({ session: child.request.session, text: "working" }));
        // The child never replies, so only the failed relay ends the Attempt.
        const exit = yield* Fiber.await(execution).pipe(Effect.timeoutOption("3 seconds"));
        yield* process.stop;

        assert(Option.isSome(exit), "execute is still running after the relay failed");
        assert(Exit.isFailure(exit.value));
        const failure = yield* Effect.flip(exit.value);
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.strictEqual(failure.message, "transcript unavailable");
        assert.deepStrictEqual(trace(recording.outbound()), ["Started", "child.SessionStarted"]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "fails the Attempt and stops its child without a resume when relaying a notice fails",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated("coordinator/notice-relay-fails");
        const attemptId = request.spec.attemptId;
        const recording = recordingSink();
        const sink = failingWhere(
          recording.sink,
          (payload) => payload._tag === "WorkerUnresponsive",
        );
        const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        const execution = yield* process.execute(request, sink);
        const child = yield* process.nextChild;
        yield* until(() => trace(recording.outbound()).includes("child.SessionStarted"));
        yield* process.attempts.notify(attemptId, unresponsive("while working"));
        const exit = yield* Fiber.await(execution).pipe(Effect.timeoutOption("3 seconds"));
        const stoppingOnClose = yield* child.closed.pipe(Effect.timeoutOption("1 second"));
        yield* process.stop;

        assert.deepStrictEqual(stoppingOnClose, Option.some(false));

        assert(Option.isSome(exit), "execute is still running after the relay failed");
        assert(Exit.isFailure(exit.value));
        const failure = yield* Effect.flip(exit.value);
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.strictEqual(failure.message, "transcript unavailable");
        assert.deepStrictEqual(unresponsiveReasons(recording.outbound()), []);
      }).pipe(Effect.scoped),
  );

  it.live("refuses envelopes after the terminal envelope while an execute call is attached", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/emit-after-end");
      const attemptId = request.spec.attemptId;
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* process.execute(request, recordingSink().sink);
      yield* (yield* process.nextChild).reply("Done.");
      yield* Fiber.join(execution);
      yield* process.stop;

      // A second `execute` call's outbox, between its attach and its detach.
      const recording = recordingSink();
      const { refused, after } = yield* Effect.gen(function* () {
        const journal = yield* AttemptJournal;
        const snapshot = yield* journal.load(attemptId);
        if (Option.isNone(snapshot)) return yield* Effect.die(new Error("no journal"));
        const outbox = yield* outboxFor(journal, attemptId);
        const refused = yield* Effect.scoped(
          Effect.gen(function* () {
            const attached = yield* outbox.attach(recording.sink, snapshot.value);
            assert.isTrue(attached);
            return yield* outbox.emit([unresponsive("after the end")]).pipe(Effect.flip);
          }),
        );
        return { refused, after: yield* journal.load(attemptId) };
      }).pipe(Effect.provide(sqliteJournal(database)));

      assert.strictEqual(refused._tag, "AgentFailure");
      assert.deepStrictEqual(recording.outbound(), []);
      assert.deepStrictEqual(
        Option.map(after, ({ outbox }) => outbox),
        Option.some([]),
      );
    }).pipe(Effect.scoped),
  );

  it.live("drops a Worker notice while an execute call is attached to an ended Attempt", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/attached-after-end");
      const attemptId = request.spec.attemptId;
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* process.execute(request, recordingSink().sink);
      yield* (yield* process.nextChild).reply("Done.");
      yield* Fiber.join(execution);
      yield* process.stop;

      // A second `execute` call's outbox, between its attach and its detach.
      const recording = recordingSink();
      const routing = yield* Effect.gen(function* () {
        const journal = yield* AttemptJournal;
        const snapshot = yield* journal.load(attemptId);
        if (Option.isNone(snapshot)) return yield* Effect.die(new Error("no journal"));
        const outbox = yield* outboxFor(journal, attemptId);
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const attached = yield* outbox.attach(recording.sink, snapshot.value);
            assert.isTrue(attached);
            return yield* outbox.notice(unresponsive("after the end"));
          }),
        );
      }).pipe(Effect.provide(sqliteJournal(database)));

      assert.strictEqual(routing._tag, "Dropped");
      assert.deepStrictEqual(recording.outbound(), []);
    }).pipe(Effect.scoped),
  );
});

describe("event-driven coordinator restarts on SQLite", () => {
  it.live("replaces a child that stopped before it saved its session, once", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("restart/before-save", 2);
      const recording = recordingSink();
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recording.sink);
      const interrupted = yield* first.nextChild;
      yield* until(() => trace(recording.outbound()).includes("child.SessionStarted"));
      yield* first.stop;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      // The run fiber reattaches only an Attempt that is live after the restart.
      const liveAfterRestart = yield* second.attempts.isLive(request.spec.attemptId);
      const execution = yield* second.execute(request, recording.sink);
      const replacement = yield* second.nextChild;
      yield* replacement.reply("Finished from the checkout.");
      const report = yield* Fiber.join(execution);
      yield* second.stop;

      assert.isTrue(liveAfterRestart);
      assert.strictEqual(report.message, "Finished from the checkout.");
      assert.notStrictEqual(replacement.request.session.id, interrupted.request.session.id);
      assert.include(replacement.request.prompt, REPLACEMENT_ASSIGNMENT);
      assertAdmitted(request.spec.attemptId, recording.outbound());
      // The stopped process may relay the first child's end before the restart relays it again.
      const sessions = trace(recording.outbound()).filter((entry) =>
        entry.startsWith("child.Session"),
      );
      assert.strictEqual(sessions.filter((entry) => entry === "child.SessionStarted").length, 2);
      assert.isBelow(
        sessions.indexOf("child.SessionFinished"),
        sessions.lastIndexOf("child.SessionStarted"),
      );
      assert.strictEqual(sessions.at(-1), "child.SessionFinished");
    }).pipe(Effect.scoped),
  );

  it.live(
    "fails as infrastructure when a stored state no longer decodes, and runs the next Attempt",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated("restart/older-shape");
        const attemptId = request.spec.attemptId;
        const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        yield* first.execute(request, recordingSink().sink);
        yield* first.nextChild;
        yield* first.stop;
        // As an upgrade that changed the state's shape leaves it.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE usine_attempt_coordination SET state = ${'{"_tag":"Delegating","child":"first"}'} WHERE attempt_id = ${attemptId}`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename: database })), Effect.orDie);

        const logged: Array<unknown> = [];
        const logger = Logger.layer([Logger.make(({ message }) => logged.push(message))]);
        const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        const failure = yield* second.attempts
          .execute(request, recordingSink().sink)
          .pipe(Effect.provide(logger), Effect.flip);
        const next = coordinated("restart/after-older-shape");
        const execution = yield* second.execute(next, recordingSink().sink);
        yield* (yield* second.nextChild).reply("Opened #13.");
        const report = yield* Fiber.join(execution);
        yield* second.stop;

        assert.strictEqual(failure._tag, "InfraFailure");
        assert.include(failure.message, `The stored state of Attempt ${attemptId}`);
        const unreadable = Schema.decodeUnknownOption(
          Schema.Tuple([
            Schema.String,
            Schema.Struct({
              attemptId: Schema.Literal(attemptId),
              record: Schema.Literal("state"),
            }),
          ]),
        );
        assert.isTrue(logged.some((message) => Option.isSome(unreadable(message))));
        assert.strictEqual(report.message, "Opened #13.");
      }).pipe(Effect.scoped),
  );

  it.live("fails as infrastructure when an earlier delegation's outcome no longer decodes", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("restart/older-earlier-outcome");
      const attemptId = request.spec.attemptId;
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recordingSink().sink);
      yield* first.nextChild;
      yield* first.stop;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* second.execute(request, recordingSink().sink);
      yield* second.nextChild;
      yield* second.stop;
      // Child 1's event was handled. Only the next event's context reads its outcome again.
      const rewritten = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE usine_attempt_delegations SET outcome = ${'{"_tag":"ChildInterrupted","child":1}'} WHERE attempt_id = ${attemptId} AND number = 1`;
        return yield* sql<{ readonly count: number }>`SELECT changes() AS count`;
      }).pipe(Effect.provide(SqliteClient.layer({ filename: database })), Effect.orDie);

      const logged: Array<unknown> = [];
      const logger = Logger.layer([Logger.make(({ message }) => logged.push(message))]);
      const third = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const failure = yield* third.attempts
        .execute(request, recordingSink().sink)
        .pipe(Effect.provide(logger), Effect.flip);
      yield* third.stop;

      assert.deepStrictEqual(rewritten, [{ count: 1 }]);
      assert.strictEqual(failure._tag, "InfraFailure");
      assert.include(failure.message, `The stored delegation outcome of Attempt ${attemptId}`);
      const unreadable = Schema.decodeUnknownOption(
        Schema.Tuple([
          Schema.String,
          Schema.Struct({
            attemptId: Schema.Literal(attemptId),
            record: Schema.Literal("delegation outcome"),
          }),
        ]),
      );
      assert.isTrue(logged.some((message) => Option.isSome(unreadable(message))));
    }).pipe(Effect.scoped),
  );

  /** The record of `attemptId` that each case rewrites in an older shape. */
  const outdatedRecords = {
    "delegation outcome": (sql: SqlClient.SqlClient, attemptId: AttemptId) =>
      sql`UPDATE usine_attempt_delegations SET outcome = ${'{"_tag":"ChildReported","child":1}'} WHERE attempt_id = ${attemptId}`,
    decision: (sql: SqlClient.SqlClient, attemptId: AttemptId) =>
      sql`UPDATE usine_attempt_events SET decision = ${'{"decision":{"_tag":"Finish"},"handler":"rule"}'} WHERE attempt_id = ${attemptId} AND event IS NULL`,
  } as const;

  for (const record of ["delegation outcome", "decision"] as const)
    it.live(`fails as infrastructure when a stored ${record} no longer decodes`, () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated(`restart/older-${record.replace(" ", "-")}`);
        const attemptId = request.spec.attemptId;
        // The child's outcome and the decision on it are stored; their transition isn't.
        const first = yield* orchestrator(
          sqliteJournal(database).pipe(interruptingTransition("ChildReported"), coordinator),
        );
        const stopped = yield* first.execute(request, recordingSink().sink);
        yield* (yield* first.nextChild).reply("Opened #12.");
        yield* Fiber.await(stopped);
        yield* first.stop;
        // As an upgrade that changed the record's shape leaves it.
        const rewritten = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* outdatedRecords[record](sql, attemptId);
          return yield* sql<{
            readonly count: number;
          }>`SELECT changes() AS count`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename: database })), Effect.orDie);

        const logged: Array<unknown> = [];
        const logger = Logger.layer([Logger.make(({ message }) => logged.push(message))]);
        const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        const failure = yield* second.attempts
          .execute(request, recordingSink().sink)
          .pipe(Effect.provide(logger), Effect.flip);
        yield* second.stop;

        assert.deepStrictEqual(rewritten, [{ count: 1 }]);
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.include(failure.message, `The stored ${record} of Attempt ${attemptId}`);
        const unreadable = Schema.decodeUnknownOption(
          Schema.Tuple([
            Schema.String,
            Schema.Struct({
              attemptId: Schema.Literal(attemptId),
              record: Schema.Literal(record),
            }),
          ]),
        );
        assert.isTrue(logged.some((message) => Option.isSome(unreadable(message))));
      }).pipe(Effect.scoped),
    );

  it.live("fails over budget when a launched child's saved conversation is unavailable", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("restart/over-budget", 1);
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const recording = recordingSink();
      yield* first.execute(request, recording.sink);
      const working = yield* first.nextChild;
      yield* working.emit(
        SessionStarted.make({
          session: working.request.session,
          harnessSession: Option.some(
            HarnessSession.make({
              id: HarnessSessionId.make("lost-conversation"),
              cwd: request.cwd,
            }),
          ),
        }),
      );
      yield* until(
        () =>
          trace(recording.outbound()).filter((entry) => entry === "child.SessionStarted").length ===
          2,
      );
      yield* first.stop;

      const second = yield* orchestrator(
        CoordinatorRuntime.layer.pipe(
          Layer.provide(Layer.mergeAll(sqliteJournal(database), WakeUp.rules)),
          Layer.provideMerge(unavailableConversations),
        ),
      );
      const failure = yield* second.attempts
        .execute(request, recordingSink().sink)
        .pipe(Effect.flip);
      yield* second.stop;

      assert.strictEqual(failure._tag, "InfraFailure");
      assert.include(failure.message, "1-child budget has no room");
    }).pipe(Effect.scoped),
  );

  for (const stage of ["before-save", "after-save"] as const)
    it.live(`launches a child again in its slot after a stop during launch (${stage})`, () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated(`restart/during-launch/${stage}`, 1);
        const attemptId = request.spec.attemptId;
        const recording = recordingSink();
        const launching = yield* Deferred.make<void>();
        const first = yield* orchestrator(
          CoordinatorRuntime.layer.pipe(
            Layer.provide(Layer.mergeAll(sqliteJournal(database), WakeUp.rules)),
            Layer.provideMerge(hangingLaunches(launching, stage)),
          ),
        );
        yield* first.execute(request, recording.sink);
        yield* Deferred.await(launching);
        yield* first.stop;

        const stoppedSnapshot = yield* stored(database, attemptId);
        const progress = Option.flatMap(stoppedSnapshot, ({ delegations }) =>
          Option.flatMap(Option.fromUndefinedOr(delegations[0]), ({ progress }) => progress),
        );
        assert.isTrue(Option.isSome(progress));
        if (Option.isSome(progress)) {
          assert.isFalse(progress.value.launched);
          assert.strictEqual(progress.value.prompted, stage === "before-save");
          assert.strictEqual(Option.isSome(progress.value.saved), stage === "after-save");
        }
        const second = yield* orchestrator(
          CoordinatorRuntime.layer.pipe(
            Layer.provide(Layer.mergeAll(sqliteJournal(database), WakeUp.rules)),
            Layer.provideMerge(unavailableConversations),
          ),
        );
        const execution = yield* second.execute(request, recording.sink);
        const relaunched = yield* Effect.raceFirst(
          second.nextChild,
          Fiber.join(execution).pipe(Effect.andThen(Effect.never)),
        );
        yield* relaunched.reply("Opened #12.");
        const report = yield* Fiber.join(execution);
        yield* second.stop;
        const snapshot = yield* stored(database, attemptId);

        assert.strictEqual(report.message, "Opened #12.");
        assert.strictEqual(relaunched.request.session.id, childSessionId(attemptId, 1));
        assert.include(relaunched.request.prompt, FIRST_ASSIGNMENT);
        assert.deepStrictEqual(
          recording
            .outbound()
            .flatMap(({ payload }) =>
              payload._tag === "SessionEvent" && payload.event._tag === "SessionStarted"
                ? [payload.event.prompt]
                : [],
            ),
          [Option.some(relaunched.request.prompt)],
        );
        assert.isTrue(Option.isNone(relaunched.request.resume));
        assert.deepStrictEqual(trace(recording.outbound()), [
          "Started",
          "child.SessionStarted",
          "child.TextOutput",
          "child.SessionFinished",
          "Final",
        ]);
        assert.deepStrictEqual(
          Option.map(snapshot, ({ events, delegations }) => ({
            events: events.map(({ event }) =>
              Option.match(tagOf(event), { onNone: () => "untagged", onSome: ({ _tag }) => _tag }),
            ),
            delegations: delegations.map(({ number }) => number),
          })),
          Option.some({ events: ["AttemptStarted", "ChildReported"], delegations: [1] }),
        );
      }).pipe(Effect.scoped),
    );

  it.live("fails a relaunched child as new without starting a replacement after a crash", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("restart/relaunched-crash", 2);
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const launching = yield* Deferred.make<void>();
      const first = yield* orchestrator(
        CoordinatorRuntime.layer.pipe(
          Layer.provide(Layer.mergeAll(sqliteJournal(database), WakeUp.rules)),
          Layer.provideMerge(hangingLaunches(launching, "after-save")),
        ),
      );
      yield* first.execute(request, recording.sink);
      yield* Deferred.await(launching);
      yield* first.stop;

      const second = yield* orchestrator(
        CoordinatorRuntime.layer.pipe(
          Layer.provide(Layer.mergeAll(sqliteJournal(database), WakeUp.rules)),
          Layer.provideMerge(unavailableConversations),
        ),
      );
      const execution = yield* second.execute(request, recording.sink);
      const relaunched = yield* second.nextChild;
      yield* relaunched.crash("ssh: closed");
      const failure = yield* Effect.raceFirst(
        Fiber.join(execution).pipe(Effect.flip, Effect.asSome),
        second.nextChild.pipe(Effect.as(Option.none())),
      );
      yield* second.stop;
      const snapshot = yield* stored(database, attemptId);

      assert.isTrue(
        Option.isSome(failure),
        "The crash must fail the attempt without a replacement",
      );
      assert.deepStrictEqual(
        Option.map(failure, ({ _tag, message }) => ({ _tag, message })),
        Option.some({ _tag: "InfraFailure", message: "ssh: closed" }),
      );
      assert.deepStrictEqual(
        Option.map(snapshot, ({ events, delegations }) => ({
          events: events.map(({ event }) =>
            Option.match(tagOf(event), { onNone: () => "untagged", onSome: ({ _tag }) => _tag }),
          ),
          delegations: delegations.map(({ number }) => number),
        })),
        Option.some({ events: ["AttemptStarted", "ChildFailed"], delegations: [1] }),
      );
      assert.strictEqual(trace(recording.outbound()).at(-1), "Failed");
    }).pipe(Effect.scoped),
  );

  it.live("resumes a child that saved its session, with the same child ID", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("restart/while-working");
      const recording = recordingSink();
      const startedChildren = () =>
        trace(recording.outbound()).filter((entry) => entry === "child.SessionStarted").length;
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recording.sink);
      const working = yield* first.nextChild;
      const harnessSession = HarnessSession.make({
        id: HarnessSessionId.make("native-1"),
        cwd: request.cwd,
      });
      yield* working.emit(
        SessionStarted.make({
          session: working.request.session,
          harnessSession: Option.some(harnessSession),
        }),
      );
      yield* until(() => startedChildren() === 2);
      yield* first.stop;
      // The stop interrupts the live child's turn before its session closes.
      const interruptedOnStop = yield* working.interrupted.pipe(Effect.timeoutOption("1 second"));

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      // The run fiber reattaches only an Attempt that is live after the restart.
      const liveAfterRestart = yield* second.attempts.isLive(request.spec.attemptId);
      const execution = yield* second.execute(request, recording.sink);
      const resumed = yield* second.nextChild;
      yield* resumed.reply("Done after the restart.");
      const report = yield* Fiber.join(execution);
      yield* second.stop;

      assert.isTrue(Option.isSome(interruptedOnStop));
      assert.isTrue(liveAfterRestart);
      assert.strictEqual(report.message, "Done after the restart.");
      assert.strictEqual(resumed.request.session.id, working.request.session.id);
      assert.deepStrictEqual(resumed.request.resume, Option.some(harnessSession));
      assertAdmitted(request.spec.attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.effect(
    "waits 10 seconds for a child whose turn interrupt hangs, then keeps it to resume",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated("restart/interrupt-hangs");
        const recording = recordingSink();
        const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        yield* first.execute(request, recording.sink);
        const working = yield* first.nextChild;
        yield* working.stall;
        // The test clock stands still, so wait by yielding instead of sleeping.
        const yieldUntil = (check: () => boolean): Effect.Effect<void> =>
          Effect.suspend(() =>
            check() ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(yieldUntil(check))),
          );
        yield* yieldUntil(() => trace(recording.outbound()).includes("child.SessionStarted"));
        const stopped = yield* Deferred.make<void>();
        yield* first.stop.pipe(
          Effect.andThen(Deferred.succeed(stopped, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* working.interrupted;
        // Advances the clock one second at a time, so a wait that started late still ends.
        let waited = 0;
        while (!(yield* Deferred.isDone(stopped)) && waited < 15) {
          yield* TestClock.adjust("1 second");
          waited += 1;
        }
        const stoppedInTime = yield* Deferred.isDone(stopped);
        const stoppingOnClose = yield* working.closed;

        assert.isTrue(stoppedInTime, "the stop didn't end after 15 seconds");
        assert.isAtLeast(waited, 10, "the stop didn't wait for the child");
        assert.isTrue(stoppingOnClose);
      }).pipe(Effect.scoped),
  );

  it.live(
    "reads a child's recorded outcome after a restart instead of starting another child",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated("restart/after-report");
        const recording = recordingSink();
        const first = yield* orchestrator(
          sqliteJournal(database).pipe(interruptingTransition("ChildReported"), coordinator),
        );
        const sessionEvents = () =>
          trace(recording.outbound()).filter((entry) => entry.startsWith("child.Session"));
        const stopped = yield* first.execute(request, recording.sink);
        const child = yield* first.nextChild;
        // A child that saved its harness session could be resumed, as Claude and Codex children are.
        yield* child.emit(
          SessionStarted.make({
            session: child.request.session,
            harnessSession: Option.some(
              HarnessSession.make({ id: HarnessSessionId.make("native-1"), cwd: request.cwd }),
            ),
          }),
        );
        yield* until(
          () => sessionEvents().filter((entry) => entry === "child.SessionStarted").length === 2,
        );
        yield* child.reply("Done before the restart.");
        const exit = yield* Fiber.await(stopped);
        yield* first.stop;
        const startedBeforeRestart = sessionEvents().filter(
          (entry) => entry === "child.SessionStarted",
        ).length;

        const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        const execution = yield* second.execute(request, recording.sink);
        const another = yield* second.nextChild.pipe(Effect.timeoutOption("200 millis"));
        // Lets a wrongly started child finish, so the assertions below report it.
        if (Option.isSome(another)) yield* another.value.reply("Done again.");
        const report = yield* Fiber.join(execution);
        yield* second.stop;

        assert.isTrue(Exit.hasInterrupts(exit));
        assert.strictEqual(report.message, "Done before the restart.");
        assert.isTrue(Option.isNone(another));
        assert.strictEqual(startedBeforeRestart, 2);
        assert.strictEqual(
          sessionEvents().filter((entry) => entry === "child.SessionStarted").length,
          startedBeforeRestart,
        );
        assert.notInclude(sessionEvents(), "child.SessionResumed");
        assertAdmitted(request.spec.attemptId, recording.outbound());
      }).pipe(Effect.scoped),
  );

  it.live(
    "applies a decision recorded before its transition without calling the handler again",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated("restart/after-decision");
        const calls = yield* Ref.make(0);
        const reviewer = Layer.succeed(
          WakeUp,
          WakeUp.of({
            handle: (event) =>
              event._tag === "ChildReported"
                ? Ref.update(calls, (count) => count + 1).pipe(
                    Effect.andThen(decides("Reviewed: the pull request is open.", "session")),
                  )
                : Effect.succeedNone,
          }),
        );
        const first = yield* orchestrator(
          sqliteJournal(database).pipe(
            interruptingTransition("ChildReported"),
            coordinatorWith(reviewer),
          ),
        );
        const stopped = yield* first.execute(request, recordingSink().sink);
        const child = yield* first.nextChild;
        yield* child.reply("Opened #12.");
        yield* Fiber.await(stopped);
        yield* first.stop;

        const second = yield* orchestrator(sqliteJournal(database).pipe(coordinatorWith(reviewer)));
        const report = yield* second.attempts.execute(request, recordingSink().sink);
        yield* second.stop;
        const calledTimes = yield* Ref.get(calls);

        assert.strictEqual(report.message, "Reviewed: the pull request is open.");
        assert.strictEqual(calledTimes, 1);
      }).pipe(Effect.scoped),
  );

  it.live("calls the handler again after a restart during its decision, and commits once", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("restart/during-decision");
      const calls = yield* Ref.make(0);
      const deciding = yield* Deferred.make<void>();
      const handler = (answer: "never" | "decide") =>
        Layer.succeed(
          WakeUp,
          WakeUp.of({
            handle: (event) =>
              event._tag !== "ChildReported"
                ? Effect.succeedNone
                : Ref.update(calls, (count) => count + 1).pipe(
                    Effect.andThen(
                      answer === "decide"
                        ? decides("Decided after the restart.", "completion")
                        : Deferred.succeed(deciding, undefined).pipe(Effect.andThen(Effect.never)),
                    ),
                  ),
          }),
        );
      const first = yield* orchestrator(
        sqliteJournal(database).pipe(coordinatorWith(handler("never"))),
      );
      yield* first.execute(request, recordingSink().sink);
      const child = yield* first.nextChild;
      yield* child.reply("Opened #12.");
      yield* Deferred.await(deciding);
      yield* first.stop;

      const second = yield* orchestrator(
        sqliteJournal(database).pipe(coordinatorWith(handler("decide"))),
      );
      const report = yield* second.attempts.execute(request, recordingSink().sink);
      yield* second.stop;
      const snapshot = yield* stored(database, request.spec.attemptId);
      const calledTimes = yield* Ref.get(calls);

      assert.strictEqual(report.message, "Decided after the restart.");
      assert.strictEqual(calledTimes, 2);
      assert.deepStrictEqual(
        Option.map(snapshot, ({ events }) => events.length),
        Option.some(2),
      );
    }).pipe(Effect.scoped),
  );

  it.live("delivers a reserved terminal envelope again after a restart", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("restart/outbox");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const failing = yield* Ref.make(true);
      // Records each envelope, then fails the first terminal one, as a process that stopped
      // before the outbox acknowledgement leaves it.
      const duplicating: AttemptChannel.Sink = {
        ...recording.sink,
        append: (direction, envelope) =>
          recording.sink.append(direction, envelope).pipe(
            Effect.andThen(
              envelope._tag === "OutboundEnvelope" && envelope.payload._tag === "Final"
                ? Ref.getAndSet(failing, false)
                : Effect.succeed(false),
            ),
            Effect.flatMap((fails) =>
              fails
                ? Effect.fail(
                    InfraFailure.make({ message: "transcript unavailable", cause: "test" }),
                  )
                : Effect.void,
            ),
          ),
      };
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* first.execute(request, duplicating);
      const child = yield* first.nextChild;
      yield* child.reply("Opened #12.");
      const failure = yield* Fiber.join(execution).pipe(Effect.flip);
      const liveBeforeRestart = yield* first.attempts.isLive(attemptId);
      const finishedBeforeRestart = yield* first.attempts.finished(attemptId);
      yield* first.stop;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const report = yield* second.attempts.execute(request, duplicating);
      const liveAfter = yield* second.attempts.isLive(attemptId);
      const finishedAfter = yield* second.attempts.finished(attemptId);
      yield* second.stop;

      assert.strictEqual(failure.message, "transcript unavailable");
      assert.isTrue(liveBeforeRestart);
      assert.isTrue(Option.isNone(finishedBeforeRestart));
      assert.strictEqual(report.message, "Opened #12.");
      assert.isFalse(liveAfter);
      assert.deepStrictEqual(finishedAfter, Option.some(ParentReported.make({ report })));
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("cancels an Attempt after a restart before any execute call reattaches it", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("restart/cancel-before-reattach");
      const attemptId = request.spec.attemptId;
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recordingSink().sink);
      yield* first.nextChild;
      yield* first.stop;

      const { changes, logger } = hubChanges();
      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const { liveBeforeCancel, canceled } = yield* Effect.gen(function* () {
        // The notice opens the Attempt's hub in the new process before the run fiber reattaches.
        yield* second.attempts.notify(attemptId, unresponsive("before the reattach"));
        const liveBeforeCancel = yield* second.attempts.isLive(attemptId);
        const canceled = yield* second.attempts
          .cancel(attemptId)
          .pipe(Effect.timeoutOption("3 seconds"));
        return { liveBeforeCancel, canceled };
      }).pipe(Effect.provide(logger));
      const liveAfterCancel = yield* second.attempts.isLive(attemptId);
      yield* second.stop;

      assert.isTrue(liveBeforeCancel);
      assert.isTrue(Option.isSome(canceled));
      assert.isFalse(liveAfterCancel);
      // The cancel drops the hub that no execute call relays.
      assert.deepStrictEqual(changes, [
        { change: "created", attemptId, hubs: 1 },
        { change: "dropped", attemptId, hubs: 0 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("relays Worker notices and a cancel after a restart reattaches the Attempt", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("restart/notices");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const startedChildren = () =>
        trace(recording.outbound()).filter((entry) => entry === "child.SessionStarted").length;
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recording.sink);
      const working = yield* first.nextChild;
      yield* working.emit(
        SessionStarted.make({
          session: working.request.session,
          harnessSession: Option.some(
            HarnessSession.make({ id: HarnessSessionId.make("native-1"), cwd: request.cwd }),
          ),
        }),
      );
      yield* until(() => startedChildren() === 2);
      yield* first.stop;
      const relayedBeforeRestart = recording.outbound().length;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* second.attempts.notify(attemptId, unresponsive("before the reattach"));
      const execution = yield* second.execute(request, slowToInterrupt(recording.sink));
      const resumed = yield* second.nextChild;
      yield* second.attempts.notify(attemptId, unresponsive("after the reattach"));
      yield* second.attempts.cancel(attemptId);
      const failure = yield* Fiber.join(execution).pipe(Effect.flip);
      yield* resumed.interrupted;
      yield* second.stop;

      const outbound = recording.outbound();
      assert.strictEqual(failure._tag, "AgentFailure");
      assertAdmitted(attemptId, outbound);
      assert.deepStrictEqual(unresponsiveReasons(outbound.slice(relayedBeforeRestart)), [
        "before the reattach",
        "after the reattach",
      ]);
      assert.strictEqual(trace(outbound).at(-1), "Interrupted");
    }).pipe(Effect.scoped),
  );
  it.live("relays a notice and a cancel after a restart that only Started preceded", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("restart/only-started");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const reached = yield* Deferred.make<void>();
      const first = yield* orchestrator(
        sqliteJournal(database).pipe(holdingStartDelegation(reached), coordinator),
      );
      yield* first.execute(request, recording.sink);
      // The first child's launch never returns, so only `Started` is reserved.
      yield* Deferred.await(reached);
      yield* first.stop;
      const beforeRestart = trace(recording.outbound());
      const relayedBeforeRestart = recording.outbound().length;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* second.execute(request, slowToInterrupt(recording.sink));
      const child = yield* second.nextChild;
      yield* until(() =>
        trace(recording.outbound().slice(relayedBeforeRestart)).includes("child.SessionStarted"),
      );
      yield* second.attempts.notify(attemptId, unresponsive("after the reattach"));
      yield* second.attempts.cancel(attemptId);
      const failure = yield* Fiber.join(execution).pipe(Effect.flip);
      yield* child.interrupted;
      yield* second.stop;

      const afterRestart = recording.outbound().slice(relayedBeforeRestart);
      assert.deepStrictEqual(beforeRestart, ["Started"]);
      assert.strictEqual(failure._tag, "AgentFailure");
      assertAdmitted(attemptId, recording.outbound());
      assert.deepStrictEqual(unresponsiveReasons(afterRestart), ["after the reattach"]);
      assert.strictEqual(trace(afterRestart).at(-1), "Interrupted");
    }).pipe(Effect.scoped),
  );

  it.live("keeps a canceled Attempt settled after a stop between Interrupted and the settle", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("restart/cancel-before-settle");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      let interruptedRelayed = false;
      const marking: AttemptChannel.Sink = {
        ...recording.sink,
        append: (direction, envelope) =>
          recording.sink.append(direction, envelope).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (envelope._tag === "OutboundEnvelope" && envelope.payload._tag === "Interrupted")
                  interruptedRelayed = true;
              }),
            ),
          ),
      };
      const first = yield* orchestrator(
        sqliteJournal(database).pipe(
          stoppingSettles(() => interruptedRelayed),
          coordinator,
        ),
      );
      const execution = yield* first.execute(request, marking);
      const child = yield* first.nextChild;
      yield* until(() => trace(recording.outbound()).includes("child.SessionStarted"));
      // A settle after `Interrupted` stops the cancel, as a process stop does.
      yield* first.attempts.cancel(attemptId).pipe(Effect.exit);
      yield* Fiber.await(execution);
      yield* child.interrupted;
      yield* first.stop;
      const relayedBeforeRestart = recording.outbound().length;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const live = yield* second.attempts.isLive(attemptId);
      const resumed = yield* second.execute(request, recording.sink);
      const ended = yield* Fiber.await(resumed).pipe(Effect.timeoutOption("3 seconds"));
      yield* second.stop;
      const journal = yield* stored(database, attemptId);

      assert.isTrue(interruptedRelayed);
      assert.isFalse(live);
      assert(Option.isSome(ended), "execute resumed the canceled Attempt");
      assert(Exit.isFailure(ended.value));
      assert.strictEqual((yield* Effect.flip(ended.value))._tag, "AgentFailure");
      assert.deepStrictEqual(recording.outbound().slice(relayedBeforeRestart), []);
      assert.deepStrictEqual(
        trace(recording.outbound()).filter((tag) =>
          ["Final", "Failed", "Interrupted"].includes(tag),
        ),
        ["Interrupted"],
      );
      assert.deepStrictEqual(
        Option.map(journal, ({ status }) => status),
        Option.some(Settled.make({ outcome: Option.none() })),
      );
    }).pipe(Effect.scoped),
  );
});
