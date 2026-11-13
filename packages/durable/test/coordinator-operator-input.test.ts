import { assert, describe, it } from "@effect/vitest";
import {
  type AgentSessionError,
  ChildBackend,
  ChildSessionJournal,
  SessionOperationError,
} from "@usine/agents/runtime";
import {
  AgentSessionId,
  HarnessSession,
  HarnessSessionId,
  SessionStarted,
  ToolStarted,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Result } from "effect";
import { type AttemptRequest, harvestedResult } from "../src/attempt-runtime.ts";
import {
  AttemptJournal,
  encodeIntervention,
  JournalError,
  QueuedInput,
  Supervision,
} from "../src/coordinator/journal.ts";
import { CoordinatorRuntime } from "../src/coordinator/runtime.ts";
import { WakeUp } from "../src/coordinator/wake-up.ts";
import { type StubChild, stubChildBackendLayer, type StubChildren } from "../src/testing.ts";
import { StoredRequest } from "../src/attempt-runtime.ts";
import { interventionsFor } from "../src/coordinator/interventions.ts";
import { memoryAttemptJournalLayer } from "../src/coordinator/memory.ts";
import { outboxFor, startedWithoutParent } from "../src/coordinator/outbox.ts";
import { supervisorFor } from "../src/coordinator/supervision.ts";
import {
  coordinated,
  coordinator,
  coordinatorWith,
  holdingFinish,
  holdingTerminalLoad,
  holdingWakeUp,
  interruptingTransition,
  orchestrator,
  stored,
  until,
} from "./coordinator-support.ts";
import {
  assertAdmitted,
  recordingSink,
  sqliteJournal,
  temporaryDatabase,
  trace,
} from "./support.ts";

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

/** Holds each child's start, after completing `reached`, until `release` completes. */
const holdingStart =
  (reached: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  (journal: Layer.Layer<AttemptJournal>) =>
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

/** A stub backend whose children's `intervene` runs `after` once the child applied the input. */
const afterApplying = (
  after: (
    applied: AttemptChannel.InterventionState,
    session: AgentSessionId,
  ) => Effect.Effect<AttemptChannel.InterventionState, AgentSessionError>,
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const services = yield* Effect.context<ChildBackend | StubChildren>();
      const backend = Context.get(services, ChildBackend);
      return Context.add(services, ChildBackend, {
        ...backend,
        launch: (child) =>
          backend.launch(child).pipe(
            Effect.map((running) => ({
              ...running,
              intervene: (
                action: AttemptChannel.OperatorAction,
                onDelivery: Parameters<typeof running.intervene>[1],
              ) =>
                running
                  .intervene(action, onDelivery)
                  .pipe(Effect.flatMap((applied) => after(applied, running.session.id))),
            })),
          ),
      });
    }),
  ).pipe(Layer.provide(stubChildBackendLayer));

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

  it.live("rejects a queued input that the child never read before a cancel's Interrupted", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/unread-cancel");
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
      yield* process.attempts.cancel(attemptId);
      const failure = yield* Fiber.join(execution).pipe(Effect.flip);
      const after = yield* stored(database, attemptId);
      yield* process.stop;

      assert.strictEqual(failure._tag, "AgentFailure");
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
        "Interrupted",
      ]);
      assert.deepStrictEqual(
        Option.map(after, ({ inputs }) => inputs),
        Option.some([]),
      );
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("waits for the starting child, and rejects input while no child is live", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/rejected");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const starting = yield* Deferred.make<void>();
      const start = yield* Deferred.make<void>();
      const deciding = yield* Deferred.make<void>();
      const decide = yield* Deferred.make<void>();
      const process = yield* orchestrator(
        sqliteJournal(database).pipe(
          holdingStart(starting, start),
          coordinatorWith(holdingWakeUp("ChildReported", deciding, decide)),
        ),
      );
      const execution = yield* process.execute(request, recording.sink);
      yield* Deferred.await(starting);
      // Input addressed to the parent waits while the delegation's child starts.
      const steer = AttemptChannel.Steer.make({ message: "Keep going." });
      const waiting = yield* Effect.forkChild(
        process.attempts.intervene(attemptId, toParent(steer)),
      );
      yield* Effect.sleep("50 millis");
      const inboundWhileStarting = recording.inbound().length;
      yield* Deferred.succeed(start, undefined);
      const child = yield* process.nextChild;
      const sessionId = child.request.session.id;
      yield* Fiber.join(waiting);
      yield* child.reply("Done.");
      // The child ended and the coordinator decides its report, so no child is live.
      yield* Deferred.await(deciding);
      yield* process.attempts.intervene(attemptId, toParent(steer));
      yield* process.attempts.intervene(
        attemptId,
        toChild(AgentSessionId.make(`${sessionId}-gone`), AttemptChannel.Release.make()),
      );
      yield* Deferred.succeed(decide, undefined);
      yield* Fiber.join(execution);
      const ended = yield* process.attempts.intervene(attemptId, toParent(steer)).pipe(Effect.flip);
      const delivered = yield* child.interventions;
      yield* process.stop;

      assert.strictEqual(inboundWhileStarting, 0);
      assert.deepStrictEqual(delivered, [steer]);
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
        {
          input: 2,
          applied: false,
          message: "This attempt has no live child session to receive the input",
        },
        { input: 3, applied: false, message: "This session is no longer live" },
      ]);
      assert.strictEqual(ended._tag, "AgentFailure");
      assert.lengthOf(recording.inbound(), 3);
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("refuses input before Started, without a transcript entry", () =>
    Effect.gen(function* () {
      const request = coordinated("input/before-started");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const deciding = yield* Deferred.make<void>();
      const decide = yield* Deferred.make<void>();
      const database = yield* temporaryDatabase;
      const process = yield* orchestrator(
        sqliteJournal(database).pipe(
          coordinatorWith(holdingWakeUp("AttemptStarted", deciding, decide)),
        ),
      );
      const execution = yield* process.execute(request, recording.sink);
      // The first event's handler decides, so the transition that reserves `Started` waits.
      yield* Deferred.await(deciding);
      const refused = yield* process.attempts
        .intervene(attemptId, toParent(AttemptChannel.Steer.make({ message: "Early." })))
        .pipe(Effect.flip);
      yield* Deferred.succeed(decide, undefined);
      yield* (yield* process.nextChild).reply("Done.");
      yield* Fiber.join(execution);
      yield* process.stop;

      assert.strictEqual(refused._tag, "AgentFailure");
      assert.deepStrictEqual(recording.inbound(), []);
      assert.deepStrictEqual(receipts(recording.outbound()), []);
      assert.strictEqual(trace(recording.outbound())[0], "Started");
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("refuses input after the terminal envelope while execute is still attached", () =>
    Effect.gen(function* () {
      const request = coordinated("input/after-final");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const database = yield* temporaryDatabase;
      const process = yield* orchestrator(
        sqliteJournal(database).pipe(holdingTerminalLoad(reached, release), coordinator),
      );
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      yield* child.reply("Done.");
      yield* Deferred.await(reached);
      const refused = yield* process.attempts
        .intervene(
          attemptId,
          toChild(child.request.session.id, AttemptChannel.Steer.make({ message: "Late." })),
        )
        .pipe(Effect.flip);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(execution);
      yield* process.stop;

      assert.strictEqual(refused._tag, "AgentFailure");
      assert.deepStrictEqual(recording.inbound(), []);
      assert.strictEqual(trace(recording.outbound()).at(-1), "Final");
    }).pipe(Effect.scoped),
  );

  it.live("applies input after the transition it waited for, so none follows the outcome", () =>
    Effect.gen(function* () {
      const request = coordinated("input/during-final");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const finishing = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const database = yield* temporaryDatabase;
      const process = yield* orchestrator(
        sqliteJournal(database).pipe(
          holdingFinish(finishing, finish),
          holdingTerminalLoad(reached, release),
          coordinator,
        ),
      );
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      yield* child.reply("Done.");
      // The transition that reserves `Final` holds the routing permit while it commits.
      yield* Deferred.await(finishing);
      const late = yield* Effect.forkChild(
        process.attempts.intervene(
          attemptId,
          toChild(child.request.session.id, AttemptChannel.Steer.make({ message: "Late." })),
        ),
      );
      yield* Effect.sleep("50 millis");
      yield* Deferred.succeed(finish, undefined);
      yield* Deferred.await(reached);
      const refused = yield* Fiber.join(late).pipe(Effect.flip);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(execution);
      yield* process.stop;

      assert.strictEqual(refused._tag, "AgentFailure");
      assert.deepStrictEqual(recording.inbound(), []);
      assert.strictEqual(trace(recording.outbound()).at(-1), "Final");
    }).pipe(Effect.scoped),
  );

  it.live("fails input addressed to the parent that waits for a child when execute detaches", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/detached-wait");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const starting = yield* Deferred.make<void>();
      const start = yield* Deferred.make<void>();
      const process = yield* orchestrator(
        sqliteJournal(database).pipe(holdingStart(starting, start), coordinator),
      );
      const execution = yield* process.execute(request, recording.sink);
      yield* Deferred.await(starting);
      const waiting = yield* Effect.forkChild(
        process.attempts.intervene(
          attemptId,
          toParent(AttemptChannel.Steer.make({ message: "Keep going." })),
        ),
      );
      yield* Effect.sleep("50 millis");
      // The execute call detaches, as on a process stop, while the delegation is still open.
      yield* Fiber.interrupt(execution);
      const failed = yield* Fiber.join(waiting).pipe(Effect.timeout("5 seconds"), Effect.flip);
      yield* process.stop;

      assert.strictEqual(failed._tag, "AgentFailure");
      assert.deepStrictEqual(recording.inbound(), []);
    }).pipe(Effect.scoped),
  );

  it.live("gives no second receipt to an input that a child queued and then refused", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/refused-after-queue");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      // The child queues the input, and then its harness reports a failure.
      const refusing = afterApplying((_applied, sessionId) =>
        Effect.fail(
          SessionOperationError.make({
            operation: "steer",
            sessionId: Option.some(sessionId),
            message: "Can't send a message to the child",
            cause: new Error("closed pipe"),
          }),
        ),
      );
      const process = yield* orchestrator(sqliteJournal(database).pipe(coordinatorOver(refusing)));
      const execution = yield* process.execute(request, recording.sink);
      const child = yield* process.nextChild;
      yield* process.attempts.intervene(
        attemptId,
        toParent(AttemptChannel.Steer.make({ message: "Run the tests." })),
      );
      const refused = yield* stored(database, attemptId);
      // The child reads the input it queued before it refused it.
      yield* child.readQueued;
      yield* child.reply("Done.");
      yield* Fiber.join(execution);
      yield* process.stop;

      assert.deepStrictEqual(receipts(recording.outbound()).map(summary), [
        { input: 1, applied: false, message: "Can't send a message to the child" },
      ]);
      assert.deepStrictEqual(
        Option.map(refused, ({ inputs, supervision }) => ({ inputs, supervision })),
        Option.some({ inputs: [], supervision: [] }),
      );
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("waits for a read receipt before it rejects the unread inputs of ended children", () =>
    Effect.gen(function* () {
      const request = coordinated("input/settle");
      const attemptId = request.spec.attemptId;
      const sessionId = AgentSessionId.make(`${attemptId}/child/1`);
      const recording = recordingSink();
      const steer = toParent(AttemptChannel.Steer.make({ message: "Run the tests." }));
      const encoded = yield* encodeIntervention(steer);
      const receipt = yield* Effect.gen(function* () {
        const journal = yield* AttemptJournal;
        const snapshot = yield* journal.open(
          StoredRequest.make({ spec: request.spec, worker: request.worker, cwd: request.cwd }),
        );
        const outbox = yield* outboxFor(journal, attemptId);
        yield* outbox.attach(recording.sink, snapshot);
        yield* outbox.emit([startedWithoutParent(request.spec)]);
        const inputSequence = AttemptChannel.Sequence.make(1);
        yield* journal.queueInput(
          attemptId,
          QueuedInput.make({
            inputSequence,
            sessionId,
            intervention: encoded,
          }),
        );
        const scope = yield* Effect.scope;
        const interventions = yield* interventionsFor(
          journal,
          {
            attemptId,
            outbox,
            // The child ended after it read the input.
            children: new Map(),
            childInputs: new Set([inputSequence]),
            supervisor: supervisorFor(journal, attemptId),
          },
          scope,
        );
        // The read's receipt waits for the routing permit.
        yield* interventions.routing.take(1);
        yield* interventions.delivery({
          _tag: "Delivery",
          inputSequence,
          intervention: steer,
          delivered: Option.some(
            AttemptChannel.InterventionState.make({ held: false, paused: false }),
          ),
        });
        // `settle` gets the permit first, as the coordinator's fiber can after a release.
        yield* interventions.routing.release(1);
        yield* interventions.settle;
        return receipts(recording.outbound()).map(summary);
      }).pipe(Effect.provide(memoryAttemptJournalLayer));

      assert.deepStrictEqual(receipt, [
        {
          input: 1,
          applied: true,
          held: false,
          paused: false,
          queued: false,
          forwardedTo: undefined,
        },
      ]);
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

  it.live("restores the native user-message items that the child observed after a restart", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/receipts");
      const recording = recordingSink();
      // The first child saves the items of its last turn before it starts, as Codex does.
      const receiving = Layer.effectContext(
        Effect.gen(function* () {
          const services = yield* Effect.context<ChildBackend | StubChildren>();
          const backend = Context.get(services, ChildBackend);
          let launches = 0;
          return Context.add(services, ChildBackend, {
            ...backend,
            launch: (child) =>
              Effect.gen(function* () {
                const journal = yield* ChildSessionJournal.current;
                if (launches++ === 0) yield* journal.received(["task", "guidance"]);
                return yield* backend.launch(child);
              }),
          });
        }),
      ).pipe(Layer.provide(stubChildBackendLayer));
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinatorOver(receiving)));
      yield* first.execute(request, recording.sink);
      const working = yield* first.nextChild;
      yield* saveSession(working, request);
      yield* sessionsStarted(recording, 2);
      yield* first.stop;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* second.execute(request, recording.sink);
      const resumed = yield* second.nextChild;
      yield* resumed.reply("Done after the restart.");
      yield* Fiber.join(execution);
      yield* second.stop;

      assert.deepStrictEqual(working.request.receipts, []);
      assert.deepStrictEqual(resumed.request.receipts, ["task", "guidance"]);
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
      const encoded = yield* encodeIntervention(steer);
      yield* Effect.flatMap(Effect.service(AttemptJournal), (journal) =>
        journal.queueInput(
          attemptId,
          QueuedInput.make({
            inputSequence: AttemptChannel.Sequence.make(1),
            sessionId,
            intervention: encoded,
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
  it.live("keeps an answer to the operator across a restart under a Hold", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/answered");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recording.sink);
      const working = yield* first.nextChild;
      yield* saveSession(working, request);
      yield* sessionsStarted(recording, 2);
      yield* first.attempts.intervene(
        attemptId,
        toParent(AttemptChannel.OperatorMessage.make({ message: "Why skip the tests?" })),
      );
      // The child answers the message and waits under the Hold when the orchestrator stops.
      yield* working.reply("The tests need a database.");
      yield* until(() => trace(recording.outbound()).includes("child.SessionIdle"));
      yield* until(() => receipts(recording.outbound()).length === 2);
      yield* first.stop;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* second.execute(request, recording.sink);
      const resumed = yield* second.nextChild;
      yield* second.attempts.intervene(attemptId, toParent(AttemptChannel.Release.make()));
      const report = yield* Fiber.join(execution);
      yield* second.stop;

      assert.deepStrictEqual(resumed.request.idle, Option.some("The tests need a database."));
      assert.isTrue(resumed.request.idleAnsweredOperator);
      assert.strictEqual(report.message, "The tests need a database.");
      assert.isTrue(report.answeredOperator);
      const completion = harvestedResult(report, { facts: [], unverifiedHandoff: Option.none() });
      assert(Result.isFailure(completion));
      assert.strictEqual(completion.failure._tag, "AgentFailure");
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("forwards the runaway guard's warning to the child resumed after a reattachment", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/warning");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recording.sink);
      const working = yield* first.nextChild;
      const sessionId = working.request.session.id;
      yield* saveSession(working, request);
      yield* sessionsStarted(recording, 2);
      yield* first.stop;
      const beforeRestart = recording.outbound().length;

      const starting = yield* Deferred.make<void>();
      const start = yield* Deferred.make<void>();
      const second = yield* orchestrator(
        sqliteJournal(database).pipe(holdingStart(starting, start), coordinator),
      );
      const execution = yield* second.execute(request, recording.sink);
      // The guard sends its restored warning once `execute` attaches, before the child resumes.
      yield* second.attempts.attached(attemptId);
      yield* Deferred.await(starting);
      const warning = AttemptChannel.Steer.make({
        message: "85 of 100 tokens used by this Attempt; commit and push your work now.",
      });
      const warned = yield* Effect.forkChild(
        second.attempts.intervene(
          attemptId,
          input(AttemptChannel.ParentTarget.make(), warning, "engine"),
        ),
      );
      yield* Effect.sleep("50 millis");
      yield* Deferred.succeed(start, undefined);
      const resumed = yield* second.nextChild;
      yield* Fiber.join(warned);
      yield* resumed.reply("Pushed the work.");
      yield* Fiber.join(execution);
      const delivered = yield* resumed.interventions;
      yield* second.stop;

      assert.deepStrictEqual(delivered, [warning]);
      assert.deepStrictEqual(receipts(recording.outbound().slice(beforeRestart)).map(summary), [
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
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  for (const action of [
    AttemptChannel.Interrupt.make(),
    AttemptChannel.OperatorMessage.make({ message: "Wait for my review." }),
  ])
    it.live(`keeps ${action._tag} that the child applied when a stop follows at once`, () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated(`input/restart/applied-${action._tag}`);
        const attemptId = request.spec.attemptId;
        const recording = recordingSink();
        // A process stop right after the child applied the input, before the coordinator goes on.
        const stopping = afterApplying(() => Effect.interrupt);
        const first = yield* orchestrator(sqliteJournal(database).pipe(coordinatorOver(stopping)));
        yield* first.execute(request, recording.sink);
        const working = yield* first.nextChild;
        yield* saveSession(working, request);
        yield* sessionsStarted(recording, 2);
        const stopped = yield* first.attempts
          .intervene(attemptId, toParent(action))
          .pipe(Effect.exit);
        const applied = yield* working.interventions;
        yield* first.stop;

        const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        const execution = yield* second.execute(request, recording.sink);
        const resumed = yield* second.nextChild;
        yield* second.attempts.intervene(attemptId, toParent(AttemptChannel.Release.make()));
        yield* resumed.reply("Reviewed and done.");
        yield* Fiber.join(execution);
        yield* second.stop;

        assert.isTrue(Exit.hasInterrupts(stopped));
        assert.deepStrictEqual(applied, [action]);
        if (action._tag === "Interrupt") {
          assert.isTrue(resumed.request.paused);
          assert.isFalse(resumed.request.held);
          assert.deepStrictEqual(resumed.request.unread, []);
        } else {
          assert.isTrue(resumed.request.held);
          assert.isFalse(resumed.request.paused);
          assert.deepStrictEqual(
            resumed.request.unread.map(({ message }) => message),
            ["Wait for my review."],
          );
        }
        assertAdmitted(attemptId, recording.outbound());
      }).pipe(Effect.scoped),
    );

  for (const { name, before, action } of [
    {
      name: "keeps the end of a Hold that a Release applied when a stop follows at once",
      before: AttemptChannel.OperatorMessage.make({ message: "Wait for my review." }),
      action: AttemptChannel.Release.make(),
    },
    {
      name: "keeps the end of a pause that a Steer applied when a stop follows at once",
      before: AttemptChannel.Interrupt.make(),
      action: AttemptChannel.Steer.make({ message: "Continue with the docs." }),
    },
  ])
    it.live(name, () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = coordinated(`input/restart/ended-${before._tag}`);
        const attemptId = request.spec.attemptId;
        const recording = recordingSink();
        // A process stop right after the child applied the second input.
        let stopNext = false;
        const stopping = afterApplying((applied) =>
          stopNext ? Effect.interrupt : Effect.succeed(applied),
        );
        const first = yield* orchestrator(sqliteJournal(database).pipe(coordinatorOver(stopping)));
        yield* first.execute(request, recording.sink);
        const working = yield* first.nextChild;
        yield* saveSession(working, request);
        yield* sessionsStarted(recording, 2);
        yield* first.attempts.intervene(attemptId, toParent(before));
        yield* working.readQueued;
        const receiptsBefore = before._tag === "OperatorMessage" ? 2 : 1;
        yield* until(() => receipts(recording.outbound()).length === receiptsBefore);
        const supervised = yield* stored(database, attemptId);
        stopNext = true;
        const stopped = yield* first.attempts
          .intervene(attemptId, toParent(action))
          .pipe(Effect.exit);
        const applied = yield* working.interventions;
        yield* first.stop;

        const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
        const execution = yield* second.execute(request, recording.sink);
        const resumed = yield* second.nextChild;
        assert.isFalse(resumed.request.held);
        assert.isFalse(resumed.request.paused);
        // No Release follows: the resumed child isn't held, so its report ends the Attempt.
        yield* resumed.reply("Reviewed and done.");
        const report = yield* Fiber.join(execution);
        yield* second.stop;

        assert.deepStrictEqual(
          Option.map(supervised, ({ supervision }) =>
            supervision.map(({ held, paused }) => ({ held, paused })),
          ),
          Option.some([
            before._tag === "OperatorMessage"
              ? { held: true, paused: false }
              : { held: false, paused: true },
          ]),
        );
        assert.isTrue(Exit.hasInterrupts(stopped));
        assert.deepStrictEqual(applied, [before, action]);
        assert.strictEqual(report.message, "Reviewed and done.");
        assertAdmitted(attemptId, recording.outbound());
      }).pipe(Effect.scoped),
    );

  it.live("restores the supervision of a child that refused an operator message", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/refused-message");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const refusing = afterApplying((_applied, sessionId) =>
        Effect.fail(
          SessionOperationError.make({
            operation: "steer",
            sessionId: Option.some(sessionId),
            message: "Can't send a message to the child",
            cause: new Error("closed pipe"),
          }),
        ),
      );
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinatorOver(refusing)));
      yield* first.execute(request, recording.sink);
      const working = yield* first.nextChild;
      yield* saveSession(working, request);
      yield* sessionsStarted(recording, 2);
      yield* first.attempts.intervene(
        attemptId,
        toParent(AttemptChannel.OperatorMessage.make({ message: "Wait for my review." })),
      );
      const refused = yield* stored(database, attemptId);
      yield* first.stop;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* second.execute(request, recording.sink);
      const resumed = yield* second.nextChild;
      assert.isFalse(resumed.request.held);
      yield* resumed.reply("Done.");
      yield* Fiber.join(execution);
      yield* second.stop;

      assert.deepStrictEqual(receipts(recording.outbound()).map(summary), [
        { input: 1, applied: false, message: "Can't send a message to the child" },
      ]);
      assert.deepStrictEqual(
        Option.map(refused, ({ inputs, supervision }) => ({ inputs, supervision })),
        Option.some({ inputs: [], supervision: [] }),
      );
      assert.deepStrictEqual(resumed.request.unread, []);
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("restores the supervision when the journal can't store an operator message", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/unstored-message");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const failingQueue = (journal: Layer.Layer<AttemptJournal>) =>
        Layer.effect(
          AttemptJournal,
          Effect.gen(function* () {
            const inner = yield* AttemptJournal;
            return AttemptJournal.of({
              ...inner,
              queueInput: (id) =>
                Effect.fail(
                  JournalError.make({
                    operation: "queue an operator input",
                    attemptId: id,
                    cause: new Error("disk full"),
                  }),
                ),
            });
          }),
        ).pipe(Layer.provide(journal));
      const first = yield* orchestrator(sqliteJournal(database).pipe(failingQueue, coordinator));
      yield* first.execute(request, recording.sink);
      const working = yield* first.nextChild;
      yield* saveSession(working, request);
      yield* sessionsStarted(recording, 2);
      yield* first.attempts.intervene(
        attemptId,
        toParent(AttemptChannel.OperatorMessage.make({ message: "Wait for my review." })),
      );
      const refused = yield* stored(database, attemptId);
      const delivered = yield* working.interventions;
      yield* first.stop;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* second.execute(request, recording.sink);
      const resumed = yield* second.nextChild;
      assert.isFalse(resumed.request.held);
      yield* resumed.reply("Done.");
      yield* Fiber.join(execution);
      yield* second.stop;

      assert.deepStrictEqual(delivered, []);
      assert.deepStrictEqual(receipts(recording.outbound()).map(summary), [
        {
          input: 1,
          applied: false,
          message: "Could not queue an operator input: disk full",
        },
      ]);
      assert.deepStrictEqual(
        Option.map(refused, ({ inputs, supervision }) => ({ inputs, supervision })),
        Option.some({ inputs: [], supervision: [] }),
      );
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("rejects input addressed to a child that a restart replaced", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/replaced", 2);
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recording.sink);
      const replaced = yield* first.nextChild;
      yield* sessionsStarted(recording, 1);
      yield* first.stop;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* second.execute(request, recording.sink);
      const replacement = yield* second.nextChild;
      yield* second.attempts.intervene(
        attemptId,
        toChild(replaced.request.session.id, AttemptChannel.Steer.make({ message: "Late." })),
      );
      yield* replacement.reply("Finished from the checkout.");
      yield* Fiber.join(execution);
      const delivered = yield* replacement.interventions;
      yield* second.stop;

      assert.notStrictEqual(replacement.request.session.id, replaced.request.session.id);
      assert.deepStrictEqual(delivered, []);
      assert.deepStrictEqual(receipts(recording.outbound()).map(summary), [
        { input: 1, applied: false, message: "This session is no longer live" },
      ]);
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("rejects waiting input when the resumed delegation ends before its child is live", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/ended-before-live", 2);
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, recording.sink);
      yield* first.nextChild;
      yield* sessionsStarted(recording, 1);
      yield* first.stop;

      const starting = yield* Deferred.make<void>();
      const start = yield* Deferred.make<void>();
      const deciding = yield* Deferred.make<void>();
      const decide = yield* Deferred.make<void>();
      const second = yield* orchestrator(
        sqliteJournal(database).pipe(
          holdingStart(starting, start),
          coordinatorWith(holdingWakeUp("ChildInterrupted", deciding, decide)),
        ),
      );
      const execution = yield* second.execute(request, recording.sink);
      yield* Deferred.await(starting);
      const waiting = yield* Effect.forkChild(
        second.attempts.intervene(
          attemptId,
          toParent(AttemptChannel.Steer.make({ message: "Keep going." })),
        ),
      );
      yield* Effect.sleep("50 millis");
      // The child saved no conversation, so its resumed delegation ends before the child is live.
      yield* Deferred.succeed(start, undefined);
      yield* Deferred.await(deciding);
      yield* Fiber.join(waiting).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.succeed(decide, undefined);
      const replacement = yield* second.nextChild;
      yield* replacement.reply("Finished from the checkout.");
      yield* Fiber.join(execution);
      const delivered = yield* replacement.interventions;
      yield* second.stop;

      assert.deepStrictEqual(delivered, []);
      assert.deepStrictEqual(receipts(recording.outbound()).map(summary), [
        {
          input: 1,
          applied: false,
          message: "This attempt has no live child session to receive the input",
        },
      ]);
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );

  it.live("sends an unread input's rejection once when a stop interrupts its journal write", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/receipt");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      // A process stop during the write that forgets the input and reserves its receipt.
      const interruptingForget = (journal: Layer.Layer<AttemptJournal>) =>
        Layer.effect(
          AttemptJournal,
          Effect.gen(function* () {
            const inner = yield* AttemptJournal;
            return AttemptJournal.of({ ...inner, forgetInput: () => Effect.interrupt });
          }),
        ).pipe(Layer.provide(journal));
      const first = yield* orchestrator(
        sqliteJournal(database).pipe(interruptingForget, coordinator),
      );
      const stopped = yield* first.execute(request, recording.sink);
      const child = yield* first.nextChild;
      yield* first.attempts.intervene(
        attemptId,
        toParent(AttemptChannel.Steer.make({ message: "Also update the docs." })),
      );
      yield* child.crash("ssh: closed");
      yield* Fiber.await(stopped);
      yield* first.stop;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const failure = yield* second.attempts.execute(request, recording.sink).pipe(Effect.flip);
      const after = yield* stored(database, attemptId);
      yield* second.stop;

      assert.strictEqual(failure._tag, "InfraFailure");
      assert.deepStrictEqual(
        receipts(recording.outbound()).map(({ _tag }) => _tag),
        ["InterventionApplied", "InterventionRejected"],
      );
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

  it.live("skips the sequence of an input whose transcript append a stop interrupted", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = coordinated("input/restart/inbound");
      const attemptId = request.spec.attemptId;
      const recording = recordingSink();
      // A process stop during the first input's transcript append.
      let interrupted = false;
      const stopping: AttemptChannel.Sink = {
        ...recording.sink,
        append: (direction, envelope) =>
          direction === "inbound" && !interrupted
            ? Effect.sync(() => {
                interrupted = true;
              }).pipe(Effect.andThen(Effect.interrupt))
            : recording.sink.append(direction, envelope),
      };
      const first = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      yield* first.execute(request, stopping);
      const working = yield* first.nextChild;
      yield* saveSession(working, request);
      yield* sessionsStarted(recording, 2);
      const lost = yield* first.attempts
        .intervene(attemptId, toParent(AttemptChannel.Steer.make({ message: "Lost." })))
        .pipe(Effect.exit);
      yield* first.stop;

      const second = yield* orchestrator(sqliteJournal(database).pipe(coordinator));
      const execution = yield* second.execute(request, recording.sink);
      const resumed = yield* second.nextChild;
      yield* second.attempts.intervene(
        attemptId,
        toParent(AttemptChannel.Steer.make({ message: "Kept." })),
      );
      yield* resumed.reply("Done.");
      yield* Fiber.join(execution);
      yield* second.stop;

      assert.isTrue(Exit.hasInterrupts(lost));
      assert.deepStrictEqual(
        recording.inbound().map(({ sequence }) => sequence),
        [2],
      );
      assert.deepStrictEqual(
        receipts(recording.outbound()).map(({ inputSequence }) => Number(inputSequence)),
        [2, 2],
      );
      assertAdmitted(attemptId, recording.outbound());
    }).pipe(Effect.scoped),
  );
});
