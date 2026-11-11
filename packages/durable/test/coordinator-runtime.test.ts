import { assert, describe, it } from "@effect/vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { HarnessSession, HarnessSessionId, SessionStarted } from "@usine/core/agent/session";
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
  Option,
  Ref,
  Schema,
  Scope,
} from "effect";
import { AttemptRequest, ParentReported, ResultRecorded } from "../src/attempt-runtime.ts";
import {
  Complete,
  FIRST_ASSIGNMENT,
  REPLACEMENT_ASSIGNMENT,
} from "../src/attempt/coordinator/rules.ts";
import { AttemptJournal } from "../src/coordinator/journal.ts";
import { CoordinatorRuntime } from "../src/coordinator/runtime.ts";
import { sqliteAttemptJournalLayer } from "../src/coordinator/sqlite/store.ts";
import { RecordedDecision, WakeUp } from "../src/coordinator/wake-up.ts";
import { stubChildBackendLayer, StubChildren } from "../src/testing.ts";
import {
  assertAdmitted,
  attemptRequest,
  recordingSink,
  temporaryDatabase,
  trace,
} from "./support.ts";

/** A request whose Attempt runs without a parent session. */
const coordinated = (attemptId: string, maxChildren = 3) => {
  const request = attemptRequest(attemptId, maxChildren);
  return AttemptRequest.make({
    ...request,
    spec: AttemptChannel.RunSpec.make({ ...request.spec, parent: "none" }),
  });
};

const sqliteJournal = (database: string) =>
  sqliteAttemptJournalLayer.pipe(
    Layer.provide(SqliteClient.layer({ filename: database })),
    Layer.orDie,
  );

/** Interrupts, as a process stop does, each transition whose event has tag `tag`. */
const interruptingTransition = (tag: string) => (journal: Layer.Layer<AttemptJournal>) =>
  Layer.effect(
    AttemptJournal,
    Effect.gen(function* () {
      const inner = yield* AttemptJournal;
      const isTagged = Schema.is(Schema.Struct({ _tag: Schema.Literal(tag) }));
      return AttemptJournal.of({
        ...inner,
        transition: (attemptId, expected, step) =>
          isTagged(step.event) ? Effect.interrupt : inner.transition(attemptId, expected, step),
      });
    }),
  ).pipe(Layer.provide(journal));

/** A coordinator runtime over the journal with stub children, waking `wakeUp`. */
const coordinatorWith = (wakeUp: Layer.Layer<WakeUp>) => (journal: Layer.Layer<AttemptJournal>) =>
  CoordinatorRuntime.layer.pipe(
    Layer.provide(Layer.mergeAll(journal, wakeUp)),
    Layer.provideMerge(stubChildBackendLayer),
  );

const coordinator = coordinatorWith(WakeUp.rules);

/**
 * Starts a runtime in its own scope, as one orchestrator process. `stop` closes the scope, which
 * interrupts its `execute` calls and children as a process stop does.
 */
const orchestrator = (layer: Layer.Layer<CoordinatorRuntime | StubChildren>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layer, scope);
    const attempts = Context.get(context, CoordinatorRuntime);
    return {
      attempts,
      nextChild: Context.get(context, StubChildren).next,
      /** Forks `execute` in the process's scope. */
      execute: (request: AttemptRequest, io: AttemptChannel.Sink) =>
        Effect.forkIn(attempts.execute(request, io), scope),
      stop: Scope.close(scope, Exit.void),
    };
  });

/** Waits until `check` holds. */
const until = (check: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() =>
    check() ? Effect.void : Effect.sleep("10 millis").pipe(Effect.andThen(until(check))),
  );

/** Reads the Attempt's journal through a separate connection. */
const stored = (database: string, attemptId: AttemptId) =>
  Effect.flatMap(Effect.service(AttemptJournal), (journal) => journal.load(attemptId)).pipe(
    Effect.provide(sqliteJournal(database)),
  );

const decides = (message: string, handler: RecordedDecision["handler"]) =>
  Effect.succeedSome(RecordedDecision.make({ decision: Complete.make({ message }), handler }));

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
        Option.map(kept, ({ spec }) => spec.parent),
        Option.some("none"),
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
        const execution = yield* process.execute(request, recording.sink);
        const child = yield* process.nextChild;
        yield* process.attempts.cancel(attemptId);
        yield* child.interrupted;
        const failure = yield* Fiber.join(execution).pipe(Effect.flip);
        const live = yield* process.attempts.isLive(attemptId);
        const finished = yield* process.attempts.finished(attemptId);
        yield* process.stop;

        assert.strictEqual(failure._tag, "AgentFailure");
        assert.isFalse(live);
        assert.isTrue(Option.isNone(finished));
        assertAdmitted(attemptId, recording.outbound());
        assert.strictEqual(trace(recording.outbound()).at(-1), "Interrupted");
      }).pipe(Effect.scoped),
  );

  it.live("refuses operator input and relays Worker notices from Started until the outcome", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("coordinator/notices");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const unresponsive = (reason: string) =>
        AttemptChannel.WorkerUnresponsive.make({
          worker: WorkerName.make("local"),
          lastAnsweredAt: DateTime.makeUnsafe("2026-11-11T08:59:00Z"),
          reason,
        });
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* process.attempts.notify(attemptId, unresponsive("before start"));
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      yield* process.attempts.notify(attemptId, unresponsive("while working"));
      const refused = yield* process.attempts
        .intervene(
          attemptId,
          AttemptChannel.Intervention.make({
            operator: "octocat",
            target: AttemptChannel.ParentTarget.make(),
            action: AttemptChannel.Steer.make({ message: "Keep going." }),
          }),
        )
        .pipe(Effect.flip);
      yield* child.reply("Done.");
      yield* Fiber.join(execution);
      yield* process.attempts.notify(attemptId, unresponsive("after the end"));
      yield* process.stop;

      assert.strictEqual(refused._tag, "AgentFailure");
      const outbound = recording.outbound();
      assertAdmitted(attemptId, outbound);
      assert.deepStrictEqual(
        outbound.flatMap(({ payload }) =>
          payload._tag === "WorkerUnresponsive" ? [payload.reason] : [],
        ),
        ["before start", "while working"],
      );
      assert.deepStrictEqual(trace(outbound).slice(0, 2), ["Started", "WorkerUnresponsive"]);
      assert.deepStrictEqual(recording.inbound(), []);
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
      const execution = yield* second.execute(request, recording.sink);
      const replacement = yield* second.nextChild;
      yield* replacement.reply("Finished from the checkout.");
      const report = yield* Fiber.join(execution);
      yield* second.stop;

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
    "fails as infrastructure when an interrupted child's replacement is over the budget",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated("restart/over-budget", 1);
        const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        yield* first.execute(request, recordingSink().sink);
        yield* first.nextChild;
        yield* first.stop;

        const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        const failure = yield* second.attempts
          .execute(request, recordingSink().sink)
          .pipe(Effect.flip);
        yield* second.stop;

        assert.strictEqual(failure._tag, "InfraFailure");
        assert.include(failure.message, "1-child budget has no room");
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

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* second.execute(request, recording.sink);
      const resumed = yield* second.nextChild;
      yield* resumed.reply("Done after the restart.");
      const report = yield* Fiber.join(execution);
      yield* second.stop;

      assert.strictEqual(report.message, "Done after the restart.");
      assert.strictEqual(resumed.request.session.id, working.request.session.id);
      assert.deepStrictEqual(resumed.request.resume, Option.some(harnessSession));
      assertAdmitted(request.spec.attemptId, recording.outbound());
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
                    Effect.andThen(decides("Reviewed: the pull request is open.", "harness")),
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
                        ? decides("Decided after the restart.", "endpoint")
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
});
