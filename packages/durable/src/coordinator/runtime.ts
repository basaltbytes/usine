import {
  type AgentReport,
  AgentSessionError,
  ChildBackend,
  reportText,
  type RunningSession,
} from "@usine/agents/runtime";
import type { AgentSessionId, ChildSessionCount } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { type StepCompletion, StepResult } from "@usine/core/step/result";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Schema,
  Scope,
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
  ChildAtCapacity,
  ChildFailed,
  ChildInterrupted,
  ChildReported,
  clamp,
  CoordinatorEvent,
  type CoordinatorState,
  type EffectIntent,
  FIRST_ASSIGNMENT,
  ReservedReport,
  ruleFor,
} from "../attempt/coordinator/rules.ts";
import { delegate, type DelegationOutcome } from "../attempt/delegation/delegation.ts";
import type { DelegationHub } from "../attempt/delegation/journal.ts";
import type { JournalError } from "../attempt/journal-error.ts";
import { childSessionId } from "../attempt/sessions.ts";
import { type Attachment, attachmentFor } from "./attachment.ts";
import { buildAttemptContext } from "./context.ts";
import { coordinatorCall, journalDelegation } from "./delegation.ts";
import {
  AttemptJournal,
  type CoordinatorOutcome,
  type CoordinatorSnapshot,
  Delegate,
  Delegation,
  type DelegationRecord,
  Failed,
  Finish,
  type Intent,
  Reported,
  type StaleRevision,
  Transition,
} from "./journal.ts";
import { type Outbox, outboxFor, startedWithoutParent } from "./outbox.ts";
import { type Interventions, interventionsFor } from "./interventions.ts";
import { type Supervisor, supervisorFor } from "./supervision.ts";
import {
  decodeDecision,
  decodeOutcome,
  decodeState,
  encodeDecision,
  encodeEvent,
  encodeState,
  type UnreadableRecord,
} from "./records.ts";
import { RecordedDecision, WakeUp } from "./wake-up.ts";

/** The in-process state of one Attempt that the event-driven coordinator runs. */
interface CoordinatorHub {
  readonly attemptId: AttemptId;
  readonly outbox: Outbox;
  readonly children: Map<AgentSessionId, RunningSession>;
  readonly childSpawns: Set<string>;
  readonly childInputs: Set<number>;
  readonly supervisor: Supervisor;
  readonly interventions: Interventions;
  /** The `execute` call relaying the Attempt. */
  readonly attachment: Attachment;
  /** Owns the hub's fibers until the finished Attempt leaves the runtime. */
  readonly scope: Scope.Closeable;
}

/** Whether `cancel` ended the `execute` call relaying the Attempt. */
const isCanceled = (hub: CoordinatorHub) =>
  Effect.map(hub.attachment.ending, (ending) => Option.contains(ending, "canceled"));

const infra = (error: JournalError) => InfraFailure.make({ message: error.message, cause: error });

/** Logs a stored record that no longer decodes, and fails the Attempt with it. */
const unreadable = (error: UnreadableRecord) =>
  Effect.logError("A stored coordinator record no longer decodes; the Attempt fails", {
    attemptId: error.attemptId,
    record: error.record,
    message: error.message,
  }).pipe(Effect.andThen(Effect.fail(InfraFailure.make({ message: error.message, cause: error }))));

const canceledFailure = () =>
  AgentFailure.make({ message: "The attempt was canceled, and its children stopped" });

/** How long a process stop waits for a live child's turn to stop before its session closes. */
const CHILD_STOP_GRACE = Duration.seconds(10);

const nonEmpty = (text: string, fallback: string) => (text.trim() === "" ? fallback : text);

/**
 * Returns the event that ends delegation `child` with `outcome`. Dies on `BudgetExceeded`: the
 * transition that decided the delegation numbered it within the child-session budget, so its
 * journal never refuses it.
 */
const eventOf = (
  child: ChildSessionCount,
  outcome: DelegationOutcome,
): Effect.Effect<CoordinatorEvent> =>
  Match.valueTags(outcome, {
    Reported: ({ report, answeredOperator }) =>
      Effect.succeed<CoordinatorEvent>(
        ChildReported.make({ child, report, answeredOperator, reserved: Option.none() }),
      ),
    Reserved: ({ report }) =>
      Effect.succeed(
        Match.valueTags(report, {
          AgentCapacityError: ({ message, resetsAt }): CoordinatorEvent =>
            ChildAtCapacity.make({
              child,
              message: nonEmpty(
                message,
                "The model provider refused the child for lack of capacity",
              ),
              resetsAt,
            }),
          AgentBlockedError: (blocked) => reservedEvent(child, "blocked", blocked),
          AgentQuestionError: (question) => reservedEvent(child, "question", question),
          AgentResultError: (failed) => reservedEvent(child, "failed", failed),
        }),
      ),
    Interrupted: ({ reason }) =>
      Effect.succeed<CoordinatorEvent>(
        ChildInterrupted.make({ child, reason: nonEmpty(reason, "the child stopped") }),
      ),
    BudgetExceeded: ({ attempted }) =>
      Effect.die(
        new Error(
          `The coordinator's delegation ${child} was refused as child ${attempted} over the budget`,
        ),
      ),
  });

const reservedEvent = (
  child: ChildSessionCount,
  kind: ReservedReport["kind"],
  report: AgentReport,
): CoordinatorEvent =>
  ChildReported.make({
    child,
    report: reportText(report),
    answeredOperator: false,
    reserved: Option.some(
      ReservedReport.make({ kind, message: nonEmpty(report.message, BLANK_REPORT_MESSAGE) }),
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

/**
 * Whether the Attempt of `snapshot` has an outcome and no envelope waits for its sink, so that no
 * `execute` call relays it again.
 */
const finished = ({ status, outbox }: CoordinatorSnapshot) =>
  Match.valueTags(status, {
    Open: () => false,
    Terminal: () => outbox.length === 0,
    Settled: () => true,
  });

const make = Effect.gen(function* () {
  const journal = yield* AttemptJournal;
  const backend = yield* ChildBackend;
  const wakeUp = yield* WakeUp;
  // The runtime's scope, which owns the delivery fibers of every Attempt.
  const scope = yield* Effect.scope;
  const creation = yield* Semaphore.make(1);
  const hubs = new Map<AttemptId, CoordinatorHub>();

  /** Creates the hub of `attemptId`. The caller holds the creation permit. */
  const created = Effect.fn("CoordinatorRuntime.hub")(function* (attemptId: AttemptId) {
    const hubScope = yield* Scope.fork(scope);
    const outbox = yield* outboxFor(journal, attemptId);
    const children = new Map<AgentSessionId, RunningSession>();
    const childInputs = new Set<number>();
    const supervisor = supervisorFor(journal, attemptId);
    const hub: CoordinatorHub = {
      attemptId,
      outbox,
      children,
      childSpawns: new Set(),
      childInputs,
      supervisor,
      interventions: yield* interventionsFor(
        journal,
        { attemptId, outbox, children, childInputs, supervisor },
        hubScope,
      ),
      attachment: yield* attachmentFor(attemptId),
      scope: hubScope,
    };
    hubs.set(attemptId, hub);
    // Closing the scope is the only way the hub leaves the runtime, at `retire` or a process stop.
    yield* Scope.addFinalizer(
      hubScope,
      Effect.suspend(() => {
        hubs.delete(attemptId);
        return Effect.logInfo("Dropped the Attempt's in-process state", {
          attemptId,
          hubs: hubs.size,
        });
      }),
    );
    yield* Effect.logInfo("Created the Attempt's in-process state", {
      attemptId,
      hubs: hubs.size,
    });
    return hub;
  });

  /** Returns the hub of `attemptId`, creating it if it has none. */
  const hubFor = (attemptId: AttemptId) =>
    creation.withPermits(1)(
      Effect.suspend(() => {
        const existing = hubs.get(attemptId);
        return existing === undefined ? created(attemptId) : Effect.succeed(existing);
      }),
    );

  /**
   * Returns the hub of `attemptId`, or `None` for a finished Attempt without one, so that a late
   * caller doesn't bring back the state that `retire` dropped.
   */
  const unfinishedHubFor = (attemptId: AttemptId) =>
    creation.withPermits(1)(
      Effect.gen(function* () {
        const existing = hubs.get(attemptId);
        if (existing !== undefined) return Option.some(existing);
        const finished = yield* isFinished(attemptId).pipe(
          Effect.catchTag("JournalError", (error) =>
            Effect.logWarning("Could not read whether the Attempt is finished; keeping its state", {
              attemptId,
              message: error.message,
            }).pipe(Effect.as(false)),
          ),
        );
        if (finished) return Option.none<CoordinatorHub>();
        const hub = yield* created(attemptId);
        return Option.some(hub);
      }),
    );

  /** Whether the journal of `attemptId` has an outcome that its sink received or that is settled. */
  const isFinished = (attemptId: AttemptId) =>
    journal.load(attemptId).pipe(Effect.map(Option.exists(finished)));

  /**
   * Drops the in-process state of `attemptId` once `done` holds and no `execute` call relays it or
   * waits to. A later `execute` call creates it again.
   */
  const retire = Effect.fn("CoordinatorRuntime.retire")(
    function* (attemptId: AttemptId, done: Effect.Effect<boolean, JournalError>) {
      yield* creation.withPermits(1)(
        Effect.gen(function* () {
          const hub = hubs.get(attemptId);
          if (hub === undefined) return;
          if (!(yield* hub.attachment.isIdle))
            return yield* Effect.logInfo(
              "An execute call relays the Attempt or waits to; it keeps its in-process state",
              { attemptId },
            );
          if (!(yield* done))
            return yield* Effect.logInfo(
              "The Attempt isn't finished; it keeps its in-process state for the next execute call",
              { attemptId },
            );
          yield* Scope.close(hub.scope, Exit.void);
        }),
      );
    },
    Effect.catchTag("JournalError", (error) =>
      Effect.logWarning("Could not read whether the Attempt is finished; keeping its state", {
        attemptId: error.attemptId,
        message: error.message,
      }),
    ),
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
      onSome: (state) => decodeState(snapshot.attemptId, state),
    });

  const delegationHub = (hub: CoordinatorHub): DelegationHub => ({
    children: hub.children,
    childSpawns: hub.childSpawns,
    childInputs: hub.childInputs,
    routing: hub.interventions.routing,
    attachment: hub.attachment.delegation,
    event: (event) => hub.outbox.relay([AttemptChannel.SessionEvent.make({ event })]),
    delivery: hub.interventions.delivery,
  });

  /**
   * Stops delegation `child` when its `execute` call is interrupted. After a cancel or a sink
   * failure, nothing resumes the child, so its delegation is interrupted while the call is attached
   * and the child's host stops it. Otherwise, as on a process stop, the call detaches first, so the
   * child's harness releases its session for a later resume. A live child's delegation then aborts
   * as on a cancel, as the Pi parent's children do when its harness closes; any other delegation is
   * interrupted.
   */
  const stopDelegation = <A, E>(
    hub: CoordinatorHub,
    child: ChildSessionCount,
    stopping: Deferred.Deferred<void>,
    running: Fiber.Fiber<A, E>,
  ) =>
    Effect.gen(function* () {
      const annotations = { attemptId: hub.attemptId, child };
      const ended = yield* hub.attachment.ending;
      if (Option.isSome(ended)) {
        yield* Effect.logInfo("The execute call ended for good; its child stops without a resume", {
          ...annotations,
          reason: ended.value,
        });
        yield* Fiber.interrupt(running);
        return;
      }
      yield* hub.attachment.release;
      if (!hub.children.has(childSessionId(hub.attemptId, child))) {
        yield* Effect.logInfo("The execute call stopped before its child ran", annotations);
        return;
      }
      yield* Effect.logInfo("The execute call stopped; stopping its live child", annotations);
      yield* Deferred.succeed(stopping, undefined);
      const stopped = yield* Fiber.await(running).pipe(Effect.timeoutOption(CHILD_STOP_GRACE));
      if (Option.isNone(stopped))
        yield* Effect.logWarning("The child didn't stop in time; its delegation is interrupted", {
          ...annotations,
          grace: Duration.format(CHILD_STOP_GRACE),
        });
    });

  /** Runs delegation `record` to its outcome and records the event that ends it. */
  const runDelegation = Effect.fn("CoordinatorRuntime.delegation")(function* (
    hub: CoordinatorHub,
    snapshot: CoordinatorSnapshot,
    record: DelegationRecord,
  ) {
    const attemptId = hub.attemptId;
    yield* Effect.annotateCurrentSpan({ attemptId, child: record.number });
    const stopping = yield* Deferred.make<void>();
    const running = yield* delegate(backend, {
      spec: snapshot.request.spec,
      hub: delegationHub(hub),
      journal: journalDelegation(journal, hub.supervisor, attemptId, record.number),
      call: coordinatorCall(
        Effect.raceFirst(hub.attachment.canceled, Deferred.await(stopping)),
        hub.interventions.childChanged,
      ),
      assignment: Option.getOrElse(record.assignment, () => FIRST_ASSIGNMENT),
    }).pipe(Effect.forkChild({ startImmediately: true }));
    const ended = yield* Fiber.await(running).pipe(
      Effect.onInterrupt(() => stopDelegation(hub, record.number, stopping, running)),
    );
    const outcome = yield* ended.pipe(
      Effect.flatMap((delegation) => eventOf(record.number, delegation)),
      Effect.catchIf(Schema.is(AgentSessionError), (error) =>
        Effect.succeed<CoordinatorEvent>(
          ChildFailed.make({
            child: record.number,
            message: nonEmpty(error.message, "The child session failed"),
          }),
        ),
      ),
    );
    const encoded = yield* encodeEvent(outcome);
    const recorded = yield* journal.settleDelegation(attemptId, record.number, encoded);
    yield* Effect.logInfo("The coordinator's child ended", {
      attemptId,
      child: record.number,
      event: outcome._tag,
    });
    return yield* decodeOutcome(attemptId, recorded);
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
      onNone: () =>
        runDelegation(hub, snapshot, record).pipe(Effect.ensuring(hub.interventions.childChanged)),
      onSome: (outcome) =>
        Effect.logInfo("Handling the outcome the child recorded before a restart", {
          attemptId: hub.attemptId,
          child: record.number,
        }).pipe(Effect.andThen(decodeOutcome(hub.attemptId, outcome))),
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
          const sequence = snapshot.nextEvent;
          const proposed = yield* wakeUp
            .handle(event, context, {
              attemptId,
              sequence,
              spec: snapshot.request.spec,
              request: hub.attachment.request,
              recordUsage: (usage) =>
                hub.outbox.relay([AttemptChannel.SessionEvent.make({ event: usage })]),
            })
            .pipe(
              Effect.raceFirst(
                hub.attachment.canceled.pipe(
                  Effect.andThen(
                    Effect.logInfo("The cancel interrupted the event's handler", {
                      attemptId,
                      event: event._tag,
                      sequence,
                    }),
                  ),
                  Effect.andThen(Effect.interrupt),
                ),
              ),
            );
          const decision = Option.getOrElse(proposed, () =>
            RecordedDecision.make({ decision: ruleFor(event, context), handler: "rule" }),
          );
          const encoded = yield* encodeDecision(decision);
          return yield* journal.decide(attemptId, sequence, encoded);
        }),
    });
    const recorded = yield* decodeDecision(attemptId, encodedDecision);
    const clamped = clamp(recorded.decision, context);
    const [next, effects] = apply(state, clamped);
    yield* Effect.logInfo("The coordinator decided the event", {
      attemptId,
      event: event._tag,
      handler: recorded.handler,
      ...Option.match(recorded.session, {
        onNone: () => ({}),
        onSome: ({ brain, route, pool, usage }) => ({
          model: brain.model,
          route,
          pool,
          tokens: usage.totalTokens,
        }),
      }),
      decision: recorded.decision._tag,
      applied: clamped._tag,
      state: next._tag,
    });
    const intents: Array<Intent> = [];
    const payloads: Array<AttemptChannel.OutboundPayload> = [];
    // The outbox relays the kept Worker notices after `Started`, once the transition commits.
    if (event._tag === "AttemptStarted") payloads.push(startedWithoutParent(snapshot.request.spec));
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
    const encodedEvent = yield* encodeEvent(event);
    const encodedState = yield* encodeState(next);
    // Under the routing permit, so an operator input's receipts don't straddle the transition.
    return yield* hub.interventions.routing.withPermits(1)(
      hub.outbox.commit(payloads, (outbound) =>
        journal.transition(
          attemptId,
          snapshot.revision,
          Transition.make({
            event: encodedEvent,
            decision: encodedDecision,
            state: encodedState,
            intents,
            outbound,
          }),
        ),
      ),
    );
  });

  /** Handles events until the Attempt has an outcome, and returns the final snapshot. */
  const drive = Effect.fn("CoordinatorRuntime.drive")(function* (hub: CoordinatorHub) {
    while (true) {
      if (yield* isCanceled(hub)) return yield* Effect.interrupt;
      const snapshot = yield* loaded(hub.attemptId);
      if (snapshot.status._tag !== "Open") return snapshot;
      const state = yield* stateOf(snapshot);
      const event = yield* nextEvent(hub, snapshot, state);
      yield* hub.interventions.settle;
      // Reload: the delegation saved progress that the context reads.
      const current = yield* loaded(hub.attemptId);
      if (current.status._tag !== "Open") {
        // A cancel settled the journal while the child ended. The top of the loop interrupts on
        // the cancel's signal, or returns the settled journal if the signal hasn't come yet.
        yield* Effect.logInfo("The journal was settled while the child ended; the event stops", {
          attemptId: hub.attemptId,
          event: event._tag,
          status: current.status._tag,
        });
        continue;
      }
      yield* handle(hub, current, state, event).pipe(
        Effect.catchTag("StaleRevision", (stale) => staleTransition(hub, stale)),
      );
    }
  });

  /**
   * Interrupts `drive` after a cancel refused its transition, or returns so that `drive` reloads a
   * journal settled before the cancel signaled. Dies for any other concurrent change.
   */
  const staleTransition = (hub: CoordinatorHub, stale: StaleRevision) =>
    Effect.gen(function* () {
      const found = { expected: stale.expected, actual: stale.actual };
      if (yield* isCanceled(hub)) {
        yield* Effect.logInfo(
          "The cancel settled the journal before this transition; it stops",
          found,
        );
        return yield* Effect.interrupt;
      }
      const latest = yield* loaded(hub.attemptId);
      if (latest.status._tag === "Settled") {
        yield* Effect.logInfo("The journal was settled before this transition; it stops", found);
        return;
      }
      return yield* Effect.die(
        new Error(
          `Attempt ${stale.attemptId} changed during its transition: expected revision ${stale.expected}, found ${stale.actual}`,
        ),
      );
    });

  /** Attaches `io`, relays the Attempt to its outcome, and returns it. */
  const relay = (
    hub: CoordinatorHub,
    request: AttemptRequest,
    io: AttemptChannel.Sink,
  ): Effect.Effect<AttemptReport, AttemptFailure | JournalError | UnreadableRecord> =>
    Effect.scoped(
      Effect.gen(function* () {
        // Runs after the call detaches, so the coordinator's waiters see the change.
        yield* Effect.addFinalizer(() => hub.interventions.childChanged);
        // Released after the outbox detaches, so the next call finds the outbox free.
        const call = yield* hub.attachment.hold;
        const snapshot = yield* loaded(hub.attemptId);
        if (!(yield* hub.outbox.attach(io, snapshot)))
          return yield* Effect.die(
            new Error(`Attempt ${hub.attemptId} has an attached outbox without an execute call`),
          );
        yield* hub.attachment.publish(call, request);
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
          Effect.raceFirst(
            hub.outbox.failed.pipe(
              // Recorded before the race interrupts `drive`, so its delegation sees why.
              Effect.tap(() => hub.attachment.end("sink failed")),
              Effect.flatMap(Effect.fail),
            ),
          ),
          Effect.exit,
        );
        // A cancel settles the journal before it signals, so `drive` can find it settled first.
        const settledByCancel =
          Exit.isSuccess(ended) &&
          ended.value.status._tag === "Settled" &&
          Option.isNone(outcomeOf(ended.value));
        if (settledByCancel || (yield* isCanceled(hub))) {
          if (Exit.isFailure(ended) && !Cause.hasInterruptsOnly(ended.cause))
            yield* Effect.logWarning(
              "The canceled Attempt's coordinator failed while it stopped; the cancel still applies",
              { cause: Cause.pretty(ended.cause) },
            );
          if ((yield* hub.outbox.started) && !(yield* hub.outbox.ended)) {
            // The stopped children's unread inputs get their rejection before the channel ends.
            yield* hub.interventions.settle.pipe(
              Effect.catch((failure) =>
                Effect.logWarning(
                  "Could not reject the unread operator inputs of the canceled Attempt",
                  { errorTag: failure._tag, message: failure.message },
                ),
              ),
            );
            yield* hub.outbox.emit([AttemptChannel.Interrupted.make()]);
          }
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
        // Every exit retires, an interrupt included: a process stop leaves an unfinished Attempt's
        // state for the call that resumes it, and a cancel that outlasted its grace has already
        // settled the journal, so the interrupted call is the last one that can drop the state.
        Effect.onExit(() => retire(attemptId, isFinished(attemptId))),
      );
    },
    (effect, request) =>
      effect.pipe(
        Effect.catchTags({
          JournalError: (error) => Effect.fail(infra(error)),
          UnreadableRecord: unreadable,
        }),
        Effect.annotateLogs({ attemptId: request.spec.attemptId }),
      ),
  );

  const isLive = Effect.fn("CoordinatorRuntime.isLive")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const snapshot = yield* journal.load(attemptId);
      const live = Option.exists(snapshot, (found) => !finished(found));
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

  const intervene = Effect.fn("CoordinatorRuntime.intervene")(
    function* (attemptId: AttemptId, intervention: AttemptChannel.Intervention) {
      yield* Effect.annotateCurrentSpan({ attemptId, action: intervention.action._tag });
      const hub = hubs.get(attemptId);
      if (hub === undefined) {
        yield* Effect.logWarning("Operator input addressed an Attempt with no live channel", {
          action: intervention.action._tag,
        });
        return yield* AgentFailure.make({ message: "This attempt has no live channel" });
      }
      yield* hub.interventions.intervene(intervention);
    },
    (effect, attemptId) =>
      effect.pipe(
        Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
        Effect.annotateLogs({ attemptId }),
      ),
  );

  const attachedTo = Effect.fn("CoordinatorRuntime.attached")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const hub = yield* unfinishedHubFor(attemptId);
    if (Option.isNone(hub))
      return yield* Effect.logInfo("The Attempt is finished; no execute call relays it again", {
        attemptId,
      }).pipe(Effect.andThen(Effect.never));
    yield* hub.value.attachment.request;
  });

  const cancel = Effect.fn("CoordinatorRuntime.cancel")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      // The coordinator has no canceled status, so the cancel settles an open journal. It does so
      // before the children stop, so a process stop after that can't resume the Attempt.
      const found = yield* journal.settleOpen(attemptId);
      if (Option.isNone(found)) {
        yield* Effect.logInfo("The Attempt has no coordinator journal; nothing to cancel");
        return;
      }
      const status = found.value._tag;
      if (status === "Open")
        yield* Effect.logInfo("The canceled Attempt had no outcome; its journal is settled");
      else
        yield* Effect.logInfo(
          "The canceled Attempt has an outcome; its caller decides to settle it",
          { status },
        );
      const hub = hubs.get(attemptId);
      const call =
        hub === undefined ? Option.none<number>() : yield* hub.attachment.end("canceled");
      if (hub !== undefined && Option.isSome(call)) {
        yield* Effect.logInfo("Canceling the coordinated Attempt; its children stop");
        yield* hub.attachment.detached(call.value);
      } else yield* Effect.logInfo("No execute call relays the Attempt; nothing to stop");
      yield* retire(attemptId, isFinished(attemptId));
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
      yield* retire(attemptId, Effect.succeed(true));
    },
    Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
  );

  const notify = Effect.fn("CoordinatorRuntime.notify")(
    function* (attemptId: AttemptId, notice: AttemptChannel.WorkerNotice) {
      yield* Effect.annotateCurrentSpan({ attemptId, notice: notice._tag });
      const hub = yield* unfinishedHubFor(attemptId);
      if (Option.isNone(hub))
        return yield* Effect.logInfo("Dropped a Worker notice for a finished Attempt", {
          notice: notice._tag,
          worker: notice.worker,
        });
      const routed = yield* hub.value.outbox.notice(notice);
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
 * Operator input goes to its target child, or to the live child for input addressed to the
 * parent; the journal keeps each child's Hold, pause, and queued input across restarts.
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
