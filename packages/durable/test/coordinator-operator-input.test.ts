import { assert, describe, it } from "@effect/vitest";
import { ChildBackend, ChildSessionJournal } from "@usine/agents/runtime";
import {
  AgentSessionId,
  HarnessSession,
  HarnessSessionId,
  SessionStarted,
  ToolStarted,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Context, Deferred, Effect, Fiber, Layer, Option, Result, Schema } from "effect";
import { type AttemptRequest, harvestedResult } from "../src/attempt-runtime.ts";
import {
  AttemptJournal,
  EncodedIntervention,
  QueuedInput,
  Supervision,
} from "../src/coordinator/journal.ts";
import { CoordinatorRuntime } from "../src/coordinator/runtime.ts";
import { WakeUp } from "../src/coordinator/wake-up.ts";
import { type StubChild, stubChildBackendLayer, type StubChildren } from "../src/testing.ts";
import {
  coordinated,
  coordinator,
  interruptingTransition,
  orchestrator,
  sqliteJournal,
  stored,
  until,
} from "./coordinator-support.ts";
import { assertAdmitted, recordingSink, temporaryDatabase, trace } from "./support.ts";

const input = (
  target: AttemptChannel.SessionTarget,
  action: AttemptChannel.OperatorAction,
  operator = "octocat",
) => AttemptChannel.Intervention.make({ operator, target, action });

const toParent = (action: AttemptChannel.OperatorAction) =>
  input(AttemptChannel.ParentTarget.make(), action);

const toChild = (sessionId: AgentSessionId, action: AttemptChannel.OperatorAction) =>
  input(AttemptChannel.ChildTarget.make({ sessionId }), action);

/** The operator-input receipts among `envelopes`, in order. */
const receipts = (envelopes: ReadonlyArray<AttemptChannel.OutboundEnvelope>) =>
  envelopes.flatMap(({ payload }) =>
    payload._tag === "InterventionApplied" || payload._tag === "InterventionRejected"
      ? [payload]
      : [],
  );

/** A receipt's input sequence, outcome, and state, for comparison. */
const summary = (receipt: ReturnType<typeof receipts>[number]) =>
  receipt._tag === "InterventionApplied"
    ? {
        input: Number(receipt.inputSequence),
        applied: true,
        held: receipt.state.held,
        paused: receipt.state.paused,
        queued: receipt.state.queued,
        forwardedTo: Option.getOrUndefined(receipt.state.forwardedTo),
      }
    : { input: Number(receipt.inputSequence), applied: false, message: receipt.message };

/** Saves the child's harness session, as Claude and Codex children do, so a restart resumes it. */
const saveSession = (child: StubChild, request: AttemptRequest) =>
  child.emit(
    SessionStarted.make({
      session: child.request.session,
      harnessSession: Option.some(
        HarnessSession.make({ id: HarnessSessionId.make("native-1"), cwd: request.cwd }),
      ),
    }),
  );

/** Waits until `recording` holds `count` started child sessions. */
const sessionsStarted = (recording: ReturnType<typeof recordingSink>, count: number) =>
  until(
    () =>
      trace(recording.outbound()).filter((entry) => entry === "child.SessionStarted").length ===
      count,
  );

/** A coordinator over `journal` whose children `backend` launches. */
const coordinatorOver =
  (backend: Layer.Layer<ChildBackend | StubChildren>) => (journal: Layer.Layer<AttemptJournal>) =>
    CoordinatorRuntime.layer.pipe(
      Layer.provide(Layer.mergeAll(journal, WakeUp.rules)),
      Layer.provideMerge(backend),
    );

describe("event-driven coordinator operator input", () => {
  it.live("forwards a parent steer to the live child and sends both of its receipts", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/steer");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      const sessionId = child.request.session.id;
      // The runaway guard's warning is a parent steer from the engine.
      const warning = AttemptChannel.Steer.make({
        message: "85 of 100 tokens used by this Attempt; commit and push your work now.",
      });
      yield* process.attempts.intervene(
        attemptId,
        input(AttemptChannel.ParentTarget.make(), warning, "engine"),
      );
      const queued = yield* stored(database, attemptId);
      yield* child.readQueued;
      yield* child.emit(
        ToolStarted.make({ session: child.request.session, callId: "1", tool: "git", input: null }),
      );
      yield* child.reply("Pushed the work.");
      const report = yield* Fiber.join(execution);
      const after = yield* stored(database, attemptId);
      const delivered = yield* child.interventions;
      yield* process.stop;

      assert.deepStrictEqual(delivered, [warning]);
      assert.deepStrictEqual(
        recording.inbound().map(({ sequence, operator, target, payload }) => ({
          sequence: Number(sequence),
          operator,
          target: target._tag,
          payload,
        })),
        [{ sequence: 1, operator: "engine", target: "Parent", payload: warning }],
      );
      assert.deepStrictEqual(receipts(recording.outbound()).map(summary), [
        {
          input: 1,
          applied: true,
          held: false,
          paused: false,
          queued: true,
          forwardedTo: sessionId,
        },
        {
          input: 1,
          applied: true,
          held: false,
          paused: false,
          queued: false,
          forwardedTo: sessionId,
        },
      ]);
      assert.deepStrictEqual(
        Option.map(queued, ({ inputs }) => inputs.map(({ inputSequence }) => inputSequence)),
        Option.some([1]),
      );
      assert.deepStrictEqual(
        Option.map(after, ({ inputs, nextInbound }) => ({ inputs, nextInbound })),
        Option.some({ inputs: [], nextInbound: AttemptChannel.Sequence.make(2) }),
      );
      // The child ran a tool after it read the steer, so its report doesn't answer the operator.
      assert.isFalse(report.answeredOperator);
      assertAdmitted(attemptId, recording.outbound());
      assert.strictEqual(trace(recording.outbound()).at(-1), "Final");
    }).pipe(Effect.scoped),
  );

  it.live("holds the child's report until release, and fails an answer without work", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/hold");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      const sessionId = child.request.session.id;
      yield* process.attempts.intervene(
        attemptId,
        toParent(AttemptChannel.OperatorMessage.make({ message: "Why skip the tests?" })),
      );
      // The child reads the message and answers it, then waits under the Hold.
      yield* child.reply("The tests need a database.");
      const early = yield* Fiber.join(execution).pipe(Effect.timeoutOption("200 millis"));
      const held = yield* stored(database, attemptId);
      yield* process.attempts.intervene(attemptId, toParent(AttemptChannel.Release.make()));
      const report = yield* Fiber.join(execution);
      const released = yield* stored(database, attemptId);
      yield* process.stop;

      assert.isTrue(Option.isNone(early));
      assert.deepStrictEqual(
        Option.map(held, ({ supervision }) => supervision),
        Option.some([Supervision.make({ sessionId, held: true, paused: false })]),
      );
      assert.deepStrictEqual(
        Option.map(released, ({ supervision }) => supervision),
        Option.some([]),
      );
      assert.deepStrictEqual(receipts(recording.outbound()).map(summary), [
        {
          input: 1,
          applied: true,
          held: true,
          paused: false,
          queued: true,
          forwardedTo: sessionId,
        },
        {
          input: 1,
          applied: true,
          held: true,
          paused: false,
          queued: false,
          forwardedTo: sessionId,
        },
        {
          input: 2,
          applied: true,
          held: false,
          paused: false,
          queued: false,
          forwardedTo: sessionId,
        },
      ]);
      assert.strictEqual(report.message, "The tests need a database.");
      assert.isTrue(report.answeredOperator);
      const completion = harvestedResult(report, { facts: [], unverifiedHandoff: Option.none() });
      assert(Result.isFailure(completion));
      assert.strictEqual(completion.failure._tag, "AgentFailure");
      assertAdmitted(attemptId, recording.outbound());
      assert.strictEqual(trace(recording.outbound()).at(-1), "Final");
    }).pipe(Effect.scoped),
  );

  it.live("pauses a child on an interrupt, and resumes it with a steer", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/interrupt");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      const sessionId = child.request.session.id;
      yield* process.attempts.intervene(
        attemptId,
        toChild(sessionId, AttemptChannel.Interrupt.make()),
      );
      const paused = yield* stored(database, attemptId);
      yield* process.attempts.intervene(
        attemptId,
        toChild(sessionId, AttemptChannel.Steer.make({ message: "Continue with the docs." })),
      );
      const resumed = yield* stored(database, attemptId);
      yield* child.reply("Updated the docs.");
      yield* Fiber.join(execution);
      yield* process.stop;

      assert.deepStrictEqual(
        Option.map(paused, ({ supervision }) => supervision),
        Option.some([Supervision.make({ sessionId, held: false, paused: true })]),
      );
      assert.deepStrictEqual(
        Option.map(resumed, ({ supervision }) => supervision),
        Option.some([]),
      );
      assert.deepStrictEqual(receipts(recording.outbound()).map(summary), [
        {
          input: 1,
          applied: true,
          held: false,
          paused: true,
          queued: false,
          forwardedTo: undefined,
        },
        {
          input: 2,
          applied: true,
          held: false,
          paused: false,
          queued: false,
          forwardedTo: undefined,
        },
      ]);
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("rejects a queued input that the child never read before the Attempt's outcome", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/unread");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      const sessionId = child.request.session.id;
      yield* process.attempts.intervene(
        attemptId,
        toParent(AttemptChannel.Steer.make({ message: "Also update the docs." })),
      );
      yield* child.crash("ssh: closed");
      const failure = yield* Fiber.join(execution).pipe(Effect.flip);
      const after = yield* stored(database, attemptId);
      yield* process.stop;

      assert.strictEqual(failure._tag, "InfraFailure");
      assert.deepStrictEqual(receipts(recording.outbound()).map(summary), [
        {
          input: 1,
          applied: true,
          held: false,
          paused: false,
          queued: true,
          forwardedTo: sessionId,
        },
        {
          input: 1,
          applied: false,
          message:
            "The child stopped before it read this message. Send it again if it still applies.",
        },
      ]);
      assert.deepStrictEqual(trace(recording.outbound()).slice(-2), [
        "InterventionRejected",
        "Failed",
      ]);
      assert.deepStrictEqual(
        Option.map(after, ({ inputs }) => inputs),
        Option.some([]),
      );
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("rejects input without a live child, and refuses it without a live channel", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/rejected");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Holds the child's start after `Started` is reserved, so no child is live yet.
      const holdingStart = (journal: Layer.Layer<AttemptJournal>) =>
        Layer.effect(
          AttemptJournal,
          Effect.gen(function* () {
            const inner = yield* AttemptJournal;
            return AttemptJournal.of({
              ...inner,
              startDelegation: (id, number) =>
                Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(inner.startDelegation(id, number)),
                ),
            });
          }),
        ).pipe(Layer.provide(journal));
      const process = yield* orchestrator(sqliteJournal(database).pipe(holdingStart, coordinator));
      const execution = yield* process.execute(request, recording.sink);
      yield* Deferred.await(reached);
      const steer = AttemptChannel.Steer.make({ message: "Keep going." });
      yield* process.attempts.intervene(attemptId, toParent(steer));
      yield* Deferred.succeed(release, undefined);
      const child = yield* process.nextChild;
      yield* process.attempts.intervene(
        attemptId,
        toChild(
          AgentSessionId.make(`${child.request.session.id}-gone`),
          AttemptChannel.Release.make(),
        ),
      );
      yield* child.reply("Done.");
      yield* Fiber.join(execution);
      const ended = yield* process.attempts.intervene(attemptId, toParent(steer)).pipe(Effect.flip);
      const delivered = yield* child.interventions;
      yield* process.stop;

      assert.deepStrictEqual(delivered, []);
      assert.deepStrictEqual(receipts(recording.outbound()).map(summary), [
        {
          input: 1,
          applied: false,
          message: "This attempt has no live child session to receive the input",
        },
        { input: 2, applied: false, message: "This session is no longer live" },
      ]);
      assert.strictEqual(ended._tag, "AgentFailure");
      assert.lengthOf(recording.inbound(), 2);
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );
});

describe("event-driven coordinator operator input across restarts", () => {
  it.live("restores the child's Hold and pause after a restart", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/supervision");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recording.sink);
      const working = yield* first.nextChild;
      const sessionId = working.request.session.id;
      yield* saveSession(working, request);
      yield* sessionsStarted(recording, 2);
      yield* first.attempts.intervene(
        attemptId,
        toParent(AttemptChannel.OperatorMessage.make({ message: "Wait for my review." })),
      );
      yield* working.readQueued;
      yield* first.attempts.intervene(attemptId, toParent(AttemptChannel.Interrupt.make()));
      yield* until(() => receipts(recording.outbound()).length === 3);
      yield* first.stop;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* second.execute(request, recording.sink);
      const resumed = yield* second.nextChild;
      yield* second.attempts.intervene(attemptId, toParent(AttemptChannel.Release.make()));
      yield* resumed.reply("Reviewed and done.");
      const report = yield* Fiber.join(execution);
      const after = yield* stored(database, attemptId);
      yield* second.stop;

      assert.strictEqual(resumed.request.session.id, sessionId);
      assert.isTrue(resumed.request.held);
      assert.isTrue(resumed.request.paused);
      assert.strictEqual(report.message, "Reviewed and done.");
      assert.deepStrictEqual(
        Option.map(after, ({ supervision, nextInbound }) => ({ supervision, nextInbound })),
        Option.some({ supervision: [], nextInbound: AttemptChannel.Sequence.make(4) }),
      );
      assert.deepStrictEqual(
        recording.inbound().map(({ sequence }) => sequence),
        [1, 2, 3],
      );
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("delivers a queued input to the resumed child after a restart", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/queued");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recording.sink);
      const working = yield* first.nextChild;
      const sessionId = working.request.session.id;
      yield* saveSession(working, request);
      yield* sessionsStarted(recording, 2);
      yield* first.attempts.intervene(
        attemptId,
        toParent(AttemptChannel.Steer.make({ message: "Fix the third finding." })),
      );
      yield* first.stop;
      const beforeRestart = recording.outbound().length;

      // The resumed child reads its restored message as soon as it starts.
      const readOnReopen = Layer.effectContext(
        Effect.gen(function* () {
          const services = yield* Effect.context<ChildBackend | StubChildren>();
          const backend = Context.get(services, ChildBackend);
          return Context.add(services, ChildBackend, {
            ...backend,
            launch: (child) =>
              Effect.gen(function* () {
                const running = yield* backend.launch(child);
                const journal = yield* ChildSessionJournal.current;
                const state = AttemptChannel.InterventionState.make({ held: false, paused: false });
                for (const { id } of child.unread) yield* journal.delivered(id, Option.some(state));
                return running;
              }),
          });
        }),
      ).pipe(Layer.provide(stubChildBackendLayer));
      const second = yield* orchestrator(
        sqliteJournal(database).pipe(coordinatorOver(readOnReopen)),
      );
      const execution = yield* second.execute(request, recording.sink);
      const resumed = yield* second.nextChild;
      yield* resumed.reply("Fixed the third finding.");
      yield* Fiber.join(execution);
      const after = yield* stored(database, attemptId);
      yield* second.stop;

      assert.deepStrictEqual(
        resumed.request.unread.map(({ message }) => message),
        ["Fix the third finding."],
      );
      assert.deepStrictEqual(receipts(recording.outbound().slice(beforeRestart)).map(summary), [
        {
          input: 1,
          applied: true,
          held: false,
          paused: false,
          queued: false,
          forwardedTo: sessionId,
        },
      ]);
      assert.deepStrictEqual(
        Option.map(after, ({ inputs }) => inputs),
        Option.some([]),
      );
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("rejects a stored input whose child ended before a restart, before the outcome", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/unreported");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const first = yield* orchestrator(
        sqliteJournal(database).pipe(interruptingTransition("ChildReported"), coordinator),
      );
      const stopped = yield* first.execute(request, recording.sink);
      const child = yield* first.nextChild;
      const sessionId = child.request.session.id;
      yield* child.reply("Done before the restart.");
      yield* Fiber.await(stopped);
      yield* first.stop;
      // An input queued just before the stop, whose second receipt the stop lost.
      const steer = toParent(AttemptChannel.Steer.make({ message: "Also update the docs." }));
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(AttemptChannel.Intervention))(
        steer,
      );
      yield* Effect.flatMap(Effect.service(AttemptJournal), (journal) =>
        journal.queueInput(
          attemptId,
          QueuedInput.make({
            inputSequence: AttemptChannel.Sequence.make(1),
            sessionId,
            intervention: EncodedIntervention.make(encoded),
          }),
        ),
      ).pipe(Effect.provide(sqliteJournal(database)));

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const report = yield* second.attempts.execute(request, recording.sink);
      const after = yield* stored(database, attemptId);
      yield* second.stop;

      assert.strictEqual(report.message, "Done before the restart.");
      const outbound = recording.outbound();
      assert.deepStrictEqual(receipts(outbound).map(summary), [
        {
          input: 1,
          applied: false,
          message:
            "The child stopped before it read this message. Send it again if it still applies.",
        },
      ]);
      assert.deepStrictEqual(trace(outbound).slice(-2), ["InterventionRejected", "Final"]);
      assert.deepStrictEqual(
        Option.map(after, ({ inputs }) => inputs),
        Option.some([]),
      );
      assertAdmitted(attemptId, outbound);
    }).pipe(Effect.scoped),
  );
});
