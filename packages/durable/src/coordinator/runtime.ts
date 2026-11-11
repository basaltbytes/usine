import { AgentSessionError, ChildBackend, type RunningSession } from "@usine/agents/runtime";
import type { AgentSessionId, ChildSessionCount } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { type StepCompletion, StepResult } from "@usine/core/step/result";
import {
  Context,
  Deferred,
  type Duration,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  Semaphore,
} from "effect";

import {
  AttemptReport,
  type AttemptRequest,
  type AttemptRuntime,
  type FinishedAttempt,
  ParentFailed,
  ParentReported,
  ResultRecorded,
  StoredRequest,
} from "../attempt-runtime.ts";
import {
  AttemptStarted,
  apply,
  AwaitingStart,
  BLANK_REPORT_MESSAGE,
  BudgetExceeded,
  ChildAtCapacity,
  ChildFailed,
  ChildInterrupted,
  ChildReported,
  clamp,
  CoordinatorEvent,
  type CoordinatorState,
  CoordinatorState as CoordinatorStateSchema,
  type EffectIntent,
  FIRST_ASSIGNMENT,
  ReservedReport,
  ruleFor,
} from "../attempt/coordinator/rules.ts";
import { delegate, type DelegationOutcome } from "../attempt/delegation/delegation.ts";
import type { DelegationHub } from "../attempt/delegation/journal.ts";
import { buildAttemptContext } from "./context.ts";
import { coordinatorCall, journalDelegation } from "./delegation.ts";
import {
  AttemptJournal,
  type CoordinatorOutcome,
  type CoordinatorSnapshot,
  Delegate,
  Delegation,
  type DelegationRecord,
  EncodedDecision,
  EncodedEvent,
  EncodedState,
  Failed,
  Finish,
  type Intent,
  type JournalError,
  Reported,
  Transition,
} from "./journal.ts";
import { type Outbox, outboxFor, startedWithoutParent } from "./outbox.ts";
import { RecordedDecision, WakeUp } from "./wake-up.ts";

/** The in-process state of one Attempt that the event-driven coordinator runs. */
interface CoordinatorHub {
  readonly attemptId: AttemptId;
  readonly outbox: Outbox;
  readonly children: Map<AgentSessionId, RunningSession>;
  readonly childSpawns: Set<string>;
  readonly childInputs: Set<number>;
  readonly routing: Semaphore.Semaphore;
  /** Completes with the request of the attached `execute` call; replaced when it detaches. */
  attached: Deferred.Deferred<AttemptRequest>;
  /** Completes when the attached `execute` call detaches; replaced when it does. */
  detached: Deferred.Deferred<void>;
  /** Completes when `cancel` stops the attached `execute` call; replaced when it detaches. */
  canceled: Deferred.Deferred<void>;
}

const codec = <S extends Schema.Top>(schema: S) => Schema.toCodecJson(schema);
const encodeEvent = Schema.encodeEffect(codec(CoordinatorEvent));
const decodeEvent = Schema.decodeUnknownEffect(codec(CoordinatorEvent));
const encodeState = Schema.encodeEffect(codec(CoordinatorStateSchema));
const decodeState = Schema.decodeUnknownEffect(codec(CoordinatorStateSchema));
const encodeDecision = Schema.encodeEffect(codec(RecordedDecision));
const decodeDecision = Schema.decodeUnknownEffect(codec(RecordedDecision));

const infra = (error: JournalError) => InfraFailure.make({ message: error.message, cause: error });

const canceledFailure = () =>
  AgentFailure.make({ message: "The attempt was canceled, and its children stopped" });

const nonEmpty = (text: string, fallback: string) => (text.trim() === "" ? fallback : text);

/** Returns the event that ends delegation `child` with `outcome`. */
const eventOf = (child: ChildSessionCount, outcome: DelegationOutcome): CoordinatorEvent =>
  Match.valueTags(outcome, {
    Reported: ({ report }): CoordinatorEvent =>
      ChildReported.make({ child, report, answeredOperator: false, reserved: Option.none() }),
    Reserved: ({ report }): CoordinatorEvent =>
      Match.valueTags(report, {
        AgentCapacityError: ({ message, resetsAt }): CoordinatorEvent =>
          ChildAtCapacity.make({
            child,
            message: nonEmpty(message, "The model provider refused the child for lack of capacity"),
            resetsAt,
          }),
        AgentBlockedError: ({ message }) => reservedEvent(child, "blocked", message),
        AgentQuestionError: ({ message }) => reservedEvent(child, "question", message),
        AgentResultError: ({ message }) => reservedEvent(child, "failed", message),
      }),
    Interrupted: ({ reason }): CoordinatorEvent =>
      ChildInterrupted.make({ child, reason: nonEmpty(reason, "the child stopped") }),
    BudgetExceeded: ({ attempted }): CoordinatorEvent => BudgetExceeded.make({ child, attempted }),
  });

const reservedEvent = (
  child: ChildSessionCount,
  kind: ReservedReport["kind"],
  message: string,
): CoordinatorEvent =>
  ChildReported.make({
    child,
    report: `[usine:${kind}]\n${message}`,
    answeredOperator: false,
    reserved: Option.some(
      ReservedReport.make({ kind, message: nonEmpty(message, BLANK_REPORT_MESSAGE) }),
    ),
  });

/** Returns the terminal envelope payload and the journal outcome of a rules outcome. */
const terminalOf = (
  outcome: Extract<EffectIntent, { readonly _tag: "Finish" }>["outcome"],
): readonly [AttemptChannel.OutboundPayload, CoordinatorOutcome] =>
  outcome._tag === "AttemptCompleted"
    ? [
        AttemptChannel.Final.make({
          result: StepResult.make({ message: outcome.message, facts: [] }),
        }),
        Reported.make({
          report: AttemptReport.make({
            message: outcome.message,
            answeredOperator: outcome.answeredOperator,
          }),
        }),
      ]
    : [
        AttemptChannel.Failed.make({ failure: outcome.failure }),
        Failed.make({ failure: outcome.failure }),
      ];

/** Returns the result of a finished Attempt's `execute` call. */
const settledOutcome = (outcome: Option.Option<CoordinatorOutcome>) =>
  Option.match(outcome, {
    onNone: () => Effect.fail(canceledFailure()),
    onSome: (found) =>
      found._tag === "Reported" ? Effect.succeed(found.report) : Effect.fail(found.failure),
  });

const outcomeOf = (snapshot: CoordinatorSnapshot) =>
  Match.valueTags(snapshot.status, {
    Open: () => Option.none<CoordinatorOutcome>(),
    Terminal: ({ outcome }) => Option.some(outcome),
    Settled: ({ outcome }) => outcome,
  });

const make = Effect.gen(function* () {
  const journal = yield* AttemptJournal;
  const backend = yield* ChildBackend;
  const wakeUp = yield* WakeUp;
  const creation = yield* Semaphore.make(1);
  const hubs = new Map<AttemptId, CoordinatorHub>();

  const hubFor = (attemptId: AttemptId) =>
    creation.withPermits(1)(
      Effect.gen(function* () {
        const existing = hubs.get(attemptId);
        if (existing !== undefined) return existing;
        const created: CoordinatorHub = {
          attemptId,
          outbox: yield* outboxFor(journal, attemptId),
          children: new Map(),
          childSpawns: new Set(),
          childInputs: new Set(),
          routing: yield* Semaphore.make(1),
          attached: yield* Deferred.make<AttemptRequest>(),
          detached: yield* Deferred.make<void>(),
          canceled: yield* Deferred.make<void>(),
        };
        hubs.set(attemptId, created);
        return created;
      }),
    );

  const loaded = (attemptId: AttemptId) =>
    journal.load(attemptId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die(new Error(`Attempt ${attemptId} has no journal`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const stateOf = (snapshot: CoordinatorSnapshot) =>
    Option.match(snapshot.state, {
      onNone: () => Effect.succeed<CoordinatorState>(AwaitingStart.make({})),
      // The coordinator encoded every state it committed.
      onSome: (state) => decodeState(state).pipe(Effect.orDie),
    });

  const delegationHub = (hub: CoordinatorHub): DelegationHub => ({
    children: hub.children,
    childSpawns: hub.childSpawns,
    childInputs: hub.childInputs,
    routing: hub.routing,
    get attached() {
      return hub.attached;
    },
    event: (event) => hub.outbox.relay([AttemptChannel.SessionEvent.make({ event })]),
    // The coordinator restores no queued input, so no child reports one.
    delivery: (delivery) =>
      Effect.logWarning("Dropped an operator input receipt the coordinator never queued", {
        attemptId: hub.attemptId,
        inputSequence: delivery.inputSequence,
      }),
  });

  /** Runs delegation `record` to its outcome and records the event that ends it. */
  const runDelegation = Effect.fn("CoordinatorRuntime.delegation")(function* (
    hub: CoordinatorHub,
    snapshot: CoordinatorSnapshot,
    record: DelegationRecord,
  ) {
    const attemptId = hub.attemptId;
    yield* Effect.annotateCurrentSpan({ attemptId, child: record.number });
    const outcome = yield* delegate(backend, {
      spec: snapshot.request.spec,
      hub: delegationHub(hub),
      journal: journalDelegation(journal, attemptId, record.number),
      call: coordinatorCall(Deferred.await(hub.canceled)),
      assignment: Option.getOrElse(record.assignment, () => FIRST_ASSIGNMENT),
    }).pipe(
      Effect.map((ended) => eventOf(record.number, ended)),
      Effect.catchIf(Schema.is(AgentSessionError), (error) =>
        Effect.succeed<CoordinatorEvent>(
          ChildFailed.make({
            child: record.number,
            message: nonEmpty(error.message, "The child session failed"),
          }),
        ),
      ),
    );
    const encoded = yield* encodeEvent(outcome).pipe(Effect.orDie);
    const recorded = yield* journal.settleDelegation(
      attemptId,
      record.number,
      EncodedEvent.make(encoded),
    );
    yield* Effect.logInfo("The coordinator's child ended", {
      attemptId,
      child: record.number,
      event: outcome._tag,
    });
    return yield* decodeEvent(recorded).pipe(Effect.orDie);
  });

  /** Returns the next event of an open Attempt, running its latest delegation if it is open. */
  const nextEvent = Effect.fn("CoordinatorRuntime.nextEvent")(function* (
    hub: CoordinatorHub,
    snapshot: CoordinatorSnapshot,
    state: CoordinatorState,
  ) {
    if (state._tag === "AwaitingStart") {
      const started: CoordinatorEvent = AttemptStarted.make({});
      return started;
    }
    if (state._tag === "Settled")
      return yield* Effect.die(
        new Error(`Attempt ${hub.attemptId} is open with a settled coordinator state`),
      );
    const record = snapshot.delegations.find(({ number }) => number === state.child);
    if (record === undefined)
      return yield* Effect.die(
        new Error(`Attempt ${hub.attemptId} delegates child ${state.child} without its record`),
      );
    return yield* Option.match(record.outcome, {
      onNone: () => runDelegation(hub, snapshot, record),
      onSome: (outcome) =>
        Effect.logInfo("Handling the outcome the child recorded before a restart", {
          attemptId: hub.attemptId,
          child: record.number,
        }).pipe(Effect.andThen(decodeEvent(outcome).pipe(Effect.orDie))),
    });
  });

  /** Decides `event` and commits the transition with its intents and envelopes. */
  const handle = Effect.fn("CoordinatorRuntime.handle")(function* (
    hub: CoordinatorHub,
    snapshot: CoordinatorSnapshot,
    state: CoordinatorState,
    event: CoordinatorEvent,
  ) {
    const attemptId = hub.attemptId;
    yield* Effect.annotateCurrentSpan({ attemptId, event: event._tag });
    const context = yield* buildAttemptContext(snapshot, event);
    const encodedDecision = yield* Option.match(snapshot.pendingDecision, {
      onSome: (recorded) =>
        Effect.logInfo("Applying the decision recorded before a restart", {
          attemptId,
          event: event._tag,
        }).pipe(Effect.as(recorded)),
      onNone: () =>
        Effect.gen(function* () {
          const proposed = yield* wakeUp.handle(event, context);
          const decision = Option.getOrElse(proposed, () =>
            RecordedDecision.make({ decision: ruleFor(event, context), handler: "rule" }),
          );
          const encoded = yield* encodeDecision(decision).pipe(Effect.orDie);
          return yield* journal.decide(
            attemptId,
            snapshot.nextEvent,
            EncodedDecision.make(encoded),
          );
        }),
    });
    const recorded = yield* decodeDecision(encodedDecision).pipe(Effect.orDie);
    const clamped = clamp(recorded.decision, context);
    const [next, effects] = apply(state, clamped);
    yield* Effect.logInfo("The coordinator decided the event", {
      attemptId,
      event: event._tag,
      handler: recorded.handler,
      decision: recorded.decision._tag,
      applied: clamped._tag,
      state: next._tag,
    });
    const intents: Array<Intent> = [];
    const payloads: Array<AttemptChannel.OutboundPayload> = [];
    if (event._tag === "AttemptStarted") {
      payloads.push(startedWithoutParent(snapshot.request.spec), ...(yield* hub.outbox.takeKept));
    }
    for (const effect of effects) {
      if (effect._tag === "Ignored")
        // The coordinator handles only events about its latest child, so a rule that ignores one
        // would repeat the same event forever.
        return yield* Effect.die(
          new Error(`The coordinator's rules ignored ${event._tag}: ${effect.reason._tag}`),
        );
      if (effect._tag === "Delegate")
        intents.push(
          Delegate.make({
            delegation: Delegation.make({
              number: effect.child,
              assignment: Option.some(effect.assignment),
            }),
          }),
        );
      else {
        const [terminal, outcome] = terminalOf(effect.outcome);
        payloads.push(terminal);
        intents.push(Finish.make({ outcome }));
      }
    }
    const encodedEvent = yield* encodeEvent(event).pipe(Effect.orDie);
    const encodedState = yield* encodeState(next).pipe(Effect.orDie);
    return yield* hub.outbox.commit(payloads, (outbound) =>
      journal.transition(
        attemptId,
        snapshot.revision,
        Transition.make({
          event: EncodedEvent.make(encodedEvent),
          decision: encodedDecision,
          state: EncodedState.make(encodedState),
          intents,
          outbound,
        }),
      ),
    );
  });

  /** Handles events until the Attempt has an outcome, and returns the final snapshot. */
  const drive = Effect.fn("CoordinatorRuntime.drive")(function* (hub: CoordinatorHub) {
    while (true) {
      if (yield* Deferred.isDone(hub.canceled)) return yield* Effect.interrupt;
      const snapshot = yield* loaded(hub.attemptId);
      if (snapshot.status._tag !== "Open") return snapshot;
      const state = yield* stateOf(snapshot);
      const event = yield* nextEvent(hub, snapshot, state);
      // Reload: the delegation saved progress that the context reads.
      const current = yield* loaded(hub.attemptId);
      yield* handle(hub, current, state, event).pipe(
        Effect.catchTag("StaleRevision", (stale) =>
          Effect.die(
            new Error(
              `Attempt ${stale.attemptId} changed during its transition: expected revision ${stale.expected}, found ${stale.actual}`,
            ),
          ),
        ),
      );
    }
  });

  /** Attaches `io`, relays the Attempt to its outcome, and returns it. */
  const relay = (
    hub: CoordinatorHub,
    request: AttemptRequest,
    io: AttemptChannel.Sink,
  ): Effect.Effect<AttemptReport, AttemptFailure | JournalError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const snapshot = yield* loaded(hub.attemptId);
        let attachedHere = false;
        // Registered before the outbox attaches, so it runs after the outbox detaches: a call
        // waiting for `detached` then finds the outbox free.
        yield* Effect.addFinalizer(() =>
          attachedHere
            ? Effect.gen(function* () {
                const detached = hub.detached;
                hub.attached = yield* Deferred.make<AttemptRequest>();
                hub.detached = yield* Deferred.make<void>();
                hub.canceled = yield* Deferred.make<void>();
                yield* Deferred.succeed(detached, undefined);
              })
            : Effect.void,
        );
        if (!(yield* hub.outbox.attach(io, snapshot))) {
          yield* Effect.logWarning(
            "Another execute call is relaying this Attempt; waiting for it to detach",
          );
          yield* Deferred.await(hub.detached);
          return yield* relay(hub, request, io);
        }
        attachedHere = true;
        yield* Deferred.succeed(hub.attached, request);
        yield* Effect.logInfo("Relaying the Attempt's channel", {
          nextSequence: snapshot.nextOutbound,
          status: snapshot.status._tag,
        });
        if (snapshot.status._tag !== "Open") return yield* settledOutcome(outcomeOf(snapshot));
        if (yield* hub.outbox.started) {
          const kept = yield* hub.outbox.takeKept;
          if (kept.length > 0) yield* hub.outbox.emit(kept);
        }
        const ended = yield* drive(hub).pipe(
          Effect.raceFirst(hub.outbox.failed.pipe(Effect.flatMap(Effect.fail))),
          Effect.exit,
        );
        if (yield* Deferred.isDone(hub.canceled)) {
          if ((yield* hub.outbox.started) && !(yield* hub.outbox.ended))
            yield* hub.outbox.emit([AttemptChannel.Interrupted.make()]);
          yield* Effect.logInfo("The canceled Attempt stopped its children");
          return yield* canceledFailure();
        }
        const final = yield* ended;
        return yield* settledOutcome(outcomeOf(final));
      }),
    );

  const execute = Effect.fn("CoordinatorRuntime.execute")(
    function* (request: AttemptRequest, io: AttemptChannel.Sink) {
      const attemptId = request.spec.attemptId;
      yield* Effect.annotateCurrentSpan({
        attemptId,
        repository: request.spec.repository,
        worker: request.worker,
      });
      const snapshot = yield* journal.open(
        StoredRequest.make({ spec: request.spec, worker: request.worker, cwd: request.cwd }),
      );
      yield* Effect.logInfo(
        snapshot.revision === 0 && snapshot.events.length === 0
          ? "Running the Attempt with the event-driven coordinator"
          : "Reattached to the Attempt's event-driven coordinator",
        { revision: snapshot.revision, status: snapshot.status._tag },
      );
      const hub = yield* hubFor(attemptId);
      return yield* relay(hub, request, io).pipe(
        Effect.tap(() => Effect.logInfo("The Attempt completed")),
        Effect.tapError((failure) =>
          Effect.logInfo("The Attempt ended without success", { failure: failure._tag }),
        ),
      );
    },
    (effect, request) =>
      effect.pipe(
        Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
        Effect.annotateLogs({ attemptId: request.spec.attemptId }),
      ),
  );

  const isLive = Effect.fn("CoordinatorRuntime.isLive")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const snapshot = yield* journal.load(attemptId);
      const live = Option.exists(snapshot, ({ status, outbox }) =>
        Match.valueTags(status, {
          Open: () => true,
          // The terminal envelope still waits for the sink.
          Terminal: () => outbox.length > 0,
          Settled: () => false,
        }),
      );
      yield* Effect.logDebug("Checked whether the coordinated Attempt is live", {
        attemptId,
        status: Option.match(snapshot, {
          onNone: () => "none",
          onSome: ({ status }) => status._tag,
        }),
        live,
      });
      return live;
    },
    Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
  );

  const finishedAttempt = Effect.fn("CoordinatorRuntime.finished")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const snapshot = yield* journal.load(attemptId);
      return Option.flatMap(snapshot, (found) =>
        found.outbox.length > 0
          ? Option.none<FinishedAttempt>()
          : Option.map(outcomeOf(found), (outcome): FinishedAttempt =>
              outcome._tag === "Failed"
                ? ParentFailed.make({ failure: outcome.failure })
                : Option.match(found.result, {
                    onNone: () => ParentReported.make({ report: outcome.report }),
                    onSome: (result) => ResultRecorded.make({ result }),
                  }),
            ),
      );
    },
    Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
  );

  const recordResult = Effect.fn("CoordinatorRuntime.recordResult")(
    function* (attemptId: AttemptId, result: StepCompletion) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      yield* journal.recordResult(attemptId, result);
      yield* Effect.logInfo("Recorded the Attempt's harvested result", {
        attemptId,
        facts: result.result.facts.length,
        outputs: result.outputs.length,
      });
    },
    Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
  );

  const recordUnsupervised = Effect.fn("CoordinatorRuntime.recordUnsupervised")(
    function* (attemptId: AttemptId, unsupervised: Duration.Duration) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      yield* journal.recordUnsupervised(attemptId, unsupervised);
    },
    Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
  );

  const unsupervised = Effect.fn("CoordinatorRuntime.unsupervised")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const snapshot = yield* journal.load(attemptId);
      return Option.flatMap(snapshot, (found) => found.unsupervised);
    },
    Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
  );

  const storedRequest = Effect.fn("CoordinatorRuntime.request")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const snapshot = yield* journal.load(attemptId);
      return Option.map(snapshot, ({ request }) => request);
    },
    Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
  );

  const intervene = Effect.fn("CoordinatorRuntime.intervene")(function* (
    attemptId: AttemptId,
    intervention: AttemptChannel.Intervention,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId, action: intervention.action._tag });
    yield* Effect.logWarning("The event-driven coordinator refused operator input", {
      attemptId,
      target: intervention.target._tag,
      action: intervention.action._tag,
    });
    return yield* AgentFailure.make({
      message: "This attempt runs without a parent session and doesn't accept operator input yet",
    });
  });

  const attachedTo = Effect.fn("CoordinatorRuntime.attached")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const hub = yield* hubFor(attemptId);
    yield* Effect.suspend(() => Deferred.await(hub.attached));
  });

  const cancel = Effect.fn("CoordinatorRuntime.cancel")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const snapshot = yield* journal.load(attemptId);
      if (Option.isNone(snapshot)) {
        yield* Effect.logInfo("The Attempt has no coordinator journal; nothing to cancel");
        return;
      }
      const hub = hubs.get(attemptId);
      if (hub !== undefined && (yield* hub.outbox.attached)) {
        const detached = hub.detached;
        yield* Effect.logInfo("Canceling the coordinated Attempt; its children stop");
        yield* Deferred.succeed(hub.canceled, undefined);
        yield* Deferred.await(detached);
      }
      yield* journal.settle(attemptId);
      yield* Effect.logInfo("The canceled Attempt is settled");
    },
    (effect, attemptId) =>
      effect.pipe(
        Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
        Effect.annotateLogs({ attemptId }),
      ),
  );

  const settle = Effect.fn("CoordinatorRuntime.settle")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      yield* journal.settle(attemptId);
      yield* Effect.logInfo("The attempt is settled; no relay will resume it", { attemptId });
    },
    Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
  );

  const notify = Effect.fn("CoordinatorRuntime.notify")(
    function* (attemptId: AttemptId, notice: AttemptChannel.WorkerNotice) {
      yield* Effect.annotateCurrentSpan({ attemptId, notice: notice._tag });
      const hub = yield* hubFor(attemptId);
      const routed = yield* hub.outbox.notice(notice);
      if (routed._tag === "Kept")
        yield* Effect.logInfo("Kept a Worker notice until the Attempt is relayed after Started", {
          notice: notice._tag,
          worker: notice.worker,
          kept: routed.kept.map(({ _tag }) => _tag),
        });
      if (routed._tag === "Dropped")
        yield* Effect.logInfo("Dropped a Worker notice that arrived after the Attempt ended", {
          notice: notice._tag,
          worker: notice.worker,
        });
    },
    (effect, attemptId) => effect.pipe(Effect.annotateLogs({ attemptId })),
  );

  return CoordinatorRuntime.of({
    execute,
    isLive,
    finished: finishedAttempt,
    recordResult,
    recordUnsupervised,
    unsupervised,
    request: storedRequest,
    intervene,
    attached: attachedTo,
    cancel,
    settle,
    notify,
  });
});

/**
 * The event-driven coordinator: runs Attempts without a parent session. Each lifecycle event wakes
 * `WakeUp`, whose decision the coordinator records, checks with the rules' `clamp`, and commits
 * with its effects and envelopes in one journal transition. Delegations run after their transition
 * commits, and an `execute` call after a restart resumes the open delegation from the journal.
 * Operator input is refused.
 */
export class CoordinatorRuntime extends Context.Service<
  CoordinatorRuntime,
  AttemptRuntime["Service"]
>()("@usine/durable/coordinator/runtime/CoordinatorRuntime") {
  static readonly layer: Layer.Layer<
    CoordinatorRuntime,
    never,
    AttemptJournal | ChildBackend | WakeUp
  > = Layer.effect(CoordinatorRuntime, make);
}
