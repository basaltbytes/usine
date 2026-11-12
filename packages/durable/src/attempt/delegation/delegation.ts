import { assembleChildPrompt } from "@usine/agents/prompt";
import {
  AgentBlockedError,
  type ChildBackend,
  AgentCapacityError,
  AgentQuestionError,
  AgentResultError,
  AgentSessionError,
  ChildRequest,
  ChildSessionJournal,
  ChildSessionLifecycle,
  ContinuationMismatchError,
  type RunningSession,
  SessionOperationError,
  WorkingDirectory,
} from "@usine/agents/runtime";
import {
  type AgentSessionEvent,
  AgentSessionId,
  ChildSession,
  ChildSessionBudget,
  ChildSessionCount,
  SessionFinished,
  SessionStarted,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Match,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import type { JournalError } from "../../coordinator/journal.ts";
import { childSessionId, parentSessionId } from "../sessions.ts";
import {
  type DelegationCall,
  type DelegationHub,
  type DelegationJournal,
  type ReservedChildReport,
  SavedChild,
} from "./journal.ts";

const Reported = Schema.TaggedStruct("Reported", {
  sessionId: AgentSessionId,
  /** The child's final message. */
  report: Schema.String,
  /** Whether the final message replies to the operator (ADR 0018). */
  answeredOperator: Schema.Boolean,
});

const Reserved = Schema.TaggedStruct("Reserved", {
  sessionId: AgentSessionId,
  /** The blocker, question, failure, or capacity refusal that the child ended with. */
  report: Schema.Union([
    AgentResultError,
    AgentCapacityError,
    AgentBlockedError,
    AgentQuestionError,
  ]),
});

const Interrupted = Schema.TaggedStruct("Interrupted", {
  sessionId: AgentSessionId,
  reason: Schema.String,
  /** The child's output retained before the interruption. */
  output: Schema.String,
});

const BudgetExceeded = Schema.TaggedStruct("BudgetExceeded", {
  /** The child count including the refused delegation. */
  attempted: ChildSessionCount,
  max: ChildSessionBudget,
});

/**
 * How one delegation ended: the child's report, a reserved report, an interruption of a saved
 * child that can't continue, or a refusal by the child-session budget.
 */
export const DelegationOutcome = Schema.Union([Reported, Reserved, Interrupted, BudgetExceeded]);
export type DelegationOutcome = typeof DelegationOutcome.Type;

/** One delegation of the Attempt's rendered task to a child. */
export interface Delegation {
  readonly spec: AttemptChannel.RunSpec;
  readonly hub: DelegationHub;
  readonly journal: DelegationJournal;
  readonly call: DelegationCall;
  /** Supplemental context or a focused assignment within the rendered task. */
  readonly assignment: string;
}

const TASK_EXCERPT_CHARACTERS = 160;

const taskExcerpt = (task: string): string => {
  const collapsed = task.replace(/\s+/gu, " ").trim();
  return collapsed.length > TASK_EXCERPT_CHARACTERS
    ? `${collapsed.slice(0, TASK_EXCERPT_CHARACTERS)}…`
    : collapsed;
};

/** Registers the child in `hub.children` until the scope closes. */
const register = (hub: DelegationHub, child: RunningSession) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      hub.children.set(child.session.id, child);
    }),
    () => Effect.sync(() => hub.children.delete(child.session.id)),
  );

const reservedReports = [
  "AgentResultError",
  "AgentCapacityError",
  "AgentBlockedError",
  "AgentQuestionError",
] as const;

/**
 * Runs one child from launch, or from its saved conversation on a replay, to its outcome. The
 * journal's owner numbers the delegation and applies the child-session budget. Restores the saved
 * child's supervision and unread operator inputs, forwards the child's events to the Attempt's
 * hub, and reports reserved reports and infrastructure failures to `call`.
 *
 * Fails with `JournalError` when the journal fails outside a progress checkpoint, and with
 * `AgentSessionError` when a new delegation's child fails to launch or ends without a report; a
 * resumed delegation returns `Interrupted` instead.
 */
export const delegate = Effect.fn("Delegation.delegate")(function* (
  backend: ChildBackend["Service"],
  { spec, hub, journal, call, assignment }: Delegation,
) {
  const parentId = parentSessionId(spec.attemptId);
  const excerpt = taskExcerpt(assignment);
  const start = yield* journal.start;
  if (start._tag === "Refused") {
    yield* Effect.annotateCurrentSpan({
      attemptId: spec.attemptId,
      attemptedChildren: start.attempted,
      maxChildren: start.max,
    });
    yield* Effect.logWarning("Child session budget exceeded", {
      attemptedChildren: start.attempted,
      maxChildren: start.max,
      parentSessionId: parentId,
      taskExcerpt: excerpt,
    });
    return BudgetExceeded.make({ attempted: start.attempted, max: start.max });
  }
  const { resumed, progress: previous, count: attemptedChildren } = start;
  yield* Effect.annotateCurrentSpan({
    attemptId: spec.attemptId,
    attemptedChildren,
    maxChildren: spec.maxChildren,
    parentSessionId: parentId,
  });
  const sessionId = childSessionId(spec.attemptId, attemptedChildren);
  /** Runs `effect` until the delegation aborts. On abort, runs `onAbort` and interrupts. */
  const untilAborted = <A, E, R>(effect: Effect.Effect<A, E, R>, onAbort: Effect.Effect<void, E>) =>
    Effect.raceFirst(
      effect,
      call.aborted.pipe(
        Effect.annotateLogs({ sessionId }),
        Effect.andThen(onAbort),
        Effect.andThen(Effect.interrupt),
      ),
    );
  const checkpoint = <A>(effect: Effect.Effect<A, JournalError>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Child progress checkpoint failed; event forwarding continues", {
          attemptId: spec.attemptId,
          sessionId,
          operation: error.operation,
          cause: error.message,
        }),
      ),
      Effect.ignore,
    );
  const interrupted = (reason: string) =>
    Effect.gen(function* () {
      const output = (yield* call.retainedOutput) || previous.output;
      hub.childSpawns.delete(sessionId);
      yield* journal.releaseSupervision(sessionId);
      yield* hub.event(
        SessionFinished.make({
          session: ChildSession.make({
            id: sessionId,
            parentId,
            agent: spec.agent.name,
            brain: spec.agent.brain,
          }),
        }),
      );
      yield* Effect.logWarning("Saved child call returns as interrupted", {
        attemptId: spec.attemptId,
        sessionId,
        reason,
      });
      return Interrupted.make({ sessionId, reason, output });
    });
  // The relay leaves the inputs of an unfinished call to that call. Registering them under the
  // routing permit lets relay passes skip them without scanning the unfinished calls.
  const restoredInputs = resumed
    ? yield* hub.routing.withPermits(1)(
        Effect.gen(function* () {
          const queued = yield* journal.queuedInputs(sessionId);
          const decoded = yield* Effect.forEach(queued, (input) =>
            Schema.decodeUnknownEffect(AttemptChannel.Intervention)(input.intervention).pipe(
              Effect.map((intervention) => ({
                inputSequence: AttemptChannel.Sequence.make(input.inputSequence),
                intervention,
              })),
            ),
          ).pipe(Effect.result);
          if (Result.isSuccess(decoded))
            for (const input of decoded.success) hub.childInputs.add(input.inputSequence);
          return decoded;
        }),
      )
    : Result.succeed([]);
  const unsettled = new Map(
    Result.isSuccess(restoredInputs)
      ? restoredInputs.success.map((input) => [input.inputSequence, input] as const)
      : [],
  );
  // Every exit settles the restored inputs that the child did not report.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const inputSequence of unsettled.keys()) hub.childInputs.delete(inputSequence);
      if (unsettled.size === 0) return;
      if (!(yield* Deferred.isDone(hub.attached))) {
        yield* Effect.logInfo("Leaving restored operator inputs for the next relay", {
          attemptId: spec.attemptId,
          sessionId,
          inputs: unsettled.size,
        });
        return;
      }
      yield* Effect.logInfo("The child call ended before it read its restored operator inputs", {
        attemptId: spec.attemptId,
        sessionId,
        inputs: unsettled.size,
      });
      for (const input of unsettled.values())
        yield* hub.delivery({
          _tag: "Delivery",
          inputSequence: input.inputSequence,
          intervention: input.intervention,
          delivered: Option.none(),
        });
      unsettled.clear();
    }),
  );
  if (Result.isFailure(restoredInputs))
    return yield* interrupted("the saved operator messages no longer decode");
  if (resumed) yield* checkpoint(call.output(previous.output));
  const decoded = yield* Option.match(previous.saved, {
    onNone: () => Effect.succeedNone,
    onSome: (value) => Schema.decodeUnknownEffect(SavedChild)(value).pipe(Effect.asSome),
  }).pipe(Effect.result);
  if (Result.isFailure(decoded))
    return yield* interrupted("the saved conversation no longer decodes");
  const saved = decoded.success;
  if (resumed && Option.isNone(saved))
    return yield* interrupted("the child did not commit a saved conversation");
  hub.childSpawns.add(sessionId);
  if (!(yield* Deferred.isDone(hub.attached))) {
    yield* Effect.logInfo(
      "Waiting for execute to supply the Attempt's child host and environment before spawning a child",
      {
        attemptId: spec.attemptId,
      },
    );
  }
  // An abort, such as the harness closing at shutdown, ends a wait for a released Attempt.
  const attachment = hub.attached;
  const lifecycle = ChildSessionLifecycle.of({
    isStopping: Effect.sync(() => hub.attached !== attachment),
  });
  const request = yield* untilAborted(
    Deferred.await(attachment),
    Effect.logInfo(
      "Abandoning the child spawn of an aborted tool call; no execute call supplied the child host",
      { attemptId: spec.attemptId, sessionId },
    ),
  );
  if (
    Option.isSome(saved) &&
    (saved.value.worker !== request.worker ||
      saved.value.harnessSession.cwd !== request.cwd ||
      Option.getOrNull(saved.value.machine) !== Option.getOrNull(request.machine))
  )
    return yield* interrupted("the original worker, machine, or checkout is unavailable");
  // Read when each child starts, so a preflight that ran after the Attempt launched applies.
  const session = ChildSession.make({
    ...(Option.isSome(saved)
      ? saved.value.session
      : { id: sessionId, parentId, agent: spec.agent.name, brain: spec.agent.brain }),
    gatewayCredential: yield* request.gatewayCredential,
  });
  const { held, paused } = yield* journal.supervision(sessionId);
  const unread = restoredInputs.success.flatMap(({ intervention }) => {
    const action = intervention.action;
    return action._tag === "Steer" || action._tag === "OperatorMessage"
      ? [{ id: action.id, message: action.message }]
      : [];
  });
  const idle = previous.idle;
  if (held || paused || Option.isSome(idle))
    yield* Effect.logInfo("Restoring the child's operator supervision before launch", {
      attemptId: spec.attemptId,
      sessionId,
      held,
      paused,
      idle: Option.isSome(idle),
    });
  if (Option.isSome(saved) && Option.isSome(saved.value.usage))
    yield* Effect.logInfo("Restoring the child's committed usage before launch", {
      attemptId: spec.attemptId,
      sessionId,
      totalTokens: saved.value.usage.value.totalTokens,
      costUsd: saved.value.usage.value.costUsd,
    });
  const childRequest = ChildRequest.make({
    session,
    cwd: WorkingDirectory.make(request.cwd),
    environment: request.environment,
    host: request.host,
    worker: request.worker,
    machine: request.machine,
    resume: Option.map(saved, (child) => child.harnessSession),
    usage: Option.flatMap(saved, (child) => child.usage),
    held,
    paused,
    idle,
    idleAnsweredOperator: Option.isSome(idle) && previous.idleAnsweredOperator,
    prompted: previous.prompted,
    continuations: previous.continuations,
    inFlight: previous.inFlight,
    unread,
    prompt: assembleChildPrompt({
      baseCommit: spec.baseCommit,
      agent: spec.agent.name,
      persona: spec.agent.persona,
      task: spec.task,
      context: assignment,
    }),
  });
  if (Option.isSome(saved) && saved.value.session.brain.harness !== spec.agent.brain.harness) {
    const stopped = yield* backend.stop(childRequest).pipe(
      Effect.provideService(ChildSessionLifecycle, lifecycle),
      Effect.tapError((error) =>
        Effect.logError("Could not stop the saved child before refusing continuation", {
          sessionId,
          harness: saved.value.session.brain.harness,
          message: error.message,
        }),
      ),
      Effect.result,
    );
    if (Result.isFailure(stopped))
      return yield* interrupted(
        `the saved child may still be running because stopping it before the harness change failed: ${stopped.failure.message}`,
      );
    const mismatch = ContinuationMismatchError.make({
      sessionId,
      field: "harness",
      message: `harness mismatch (saved ${saved.value.session.brain.harness}, current ${spec.agent.brain.harness})`,
    });
    return yield* interrupted(mismatch.message);
  }
  yield* Effect.annotateCurrentSpan({ agent: session.agent, sessionId: session.id });
  yield* Effect.logInfo(
    "Spawning child session with the rendered task and supplemental parent context",
    {
      attemptedChildren,
      maxChildren: spec.maxChildren,
      sessionId: session.id,
      taskCharacters: spec.task.length,
      contextCharacters: assignment.length,
      taskExcerpt: excerpt,
    },
  );
  const recordInfrastructureFailure = (error: AgentSessionError) =>
    !resumed && (error._tag === "SessionOperationError" || error._tag === "SessionInterruptedError")
      ? Effect.logWarning("Child infrastructure failure requires an automatic retry", {
          attemptId: spec.attemptId,
          sessionId,
          message: error.message,
        }).pipe(
          Effect.andThen(call.infrastructureFailed(sessionId, error.message)),
          Effect.mapError((cause) =>
            SessionOperationError.make({
              operation: "stream",
              sessionId: Option.some(sessionId),
              message: cause.message,
              cause,
            }),
          ),
        )
      : Effect.void;
  const journalError = (cause: JournalError) =>
    SessionOperationError.make({
      operation: "launch",
      sessionId: Option.some(sessionId),
      message: cause.message,
      cause,
    });
  const sessionJournal = ChildSessionJournal.of({
    started: Effect.fn("Delegation.saveSession")(function* (reference) {
      yield* Effect.annotateCurrentSpan({ sessionId });
      const recovery = yield* Schema.encodeEffect(SavedChild)(
        SavedChild.make({
          session: {
            id: session.id,
            parentId: session.parentId,
            agent: session.agent,
            brain: session.brain,
          },
          usage: childRequest.usage,
          harnessSession: reference,
          worker: request.worker,
          machine: request.machine,
        }),
      ).pipe(Effect.orDie);
      yield* journal
        .saveSession(recovery, { beforePrompt: true })
        .pipe(Effect.mapError(journalError));
    }),
    prompted: Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ sessionId });
      yield* journal.savePrompted.pipe(Effect.mapError(journalError));
    }).pipe(Effect.withSpan("Delegation.savePrompted")),
    continued: Effect.fn("Delegation.saveContinuations")(function* (timestamps) {
      yield* Effect.annotateCurrentSpan({ sessionId });
      yield* journal.saveContinuations(timestamps).pipe(Effect.mapError(journalError));
    }),
    delivered: (id, delivered) =>
      Effect.suspend(() => {
        const input = [...unsettled.values()].find(
          ({ intervention }) =>
            (intervention.action._tag === "Steer" ||
              intervention.action._tag === "OperatorMessage") &&
            intervention.action.id === id,
        );
        if (input === undefined) return Effect.void;
        unsettled.delete(input.inputSequence);
        return hub.delivery({
          _tag: "Delivery",
          inputSequence: input.inputSequence,
          intervention: input.intervention,
          delivered: Option.map(delivered, (state) =>
            AttemptChannel.InterventionState.make({
              ...state,
              forwardedTo:
                input.intervention.target._tag === "Parent"
                  ? Option.some(sessionId)
                  : Option.none(),
            }),
          ),
        });
      }),
  });
  const runChild = Effect.gen(function* () {
    // Annotate logs with the Attempt because a delegation runs outside the Attempt's fiber. An
    // abort interrupts a launch that is still waiting through retry delays.
    const child = yield* untilAborted(
      backend
        .launch(childRequest)
        .pipe(
          Effect.provideService(ChildSessionLifecycle, lifecycle),
          Effect.provideService(ChildSessionJournal, sessionJournal),
          Effect.tapError(recordInfrastructureFailure),
          Effect.annotateLogs({ attemptId: spec.attemptId, worker: request.worker }),
        ),
      Effect.logInfo("Abandoning the child launch of an aborted tool call", {
        sessionId: session.id,
      }),
    );
    yield* register(hub, child);
    yield* Effect.addFinalizer((exit) =>
      Exit.isFailure(exit)
        ? Effect.logWarning("Child session ended before returning a result", {
            sessionId: session.id,
          }).pipe(Effect.andThen(hub.event(SessionFinished.make({ session: child.session }))))
        : Effect.void,
    );
    yield* call.publish({ childSessionId: session.id });
    let cumulativeUsage = childRequest.usage;
    const forward = (event: AgentSessionEvent) =>
      Effect.gen(function* () {
        if (event._tag === "ToolStarted" || event._tag === "ToolFinished")
          yield* checkpoint(
            event._tag === "ToolStarted"
              ? journal.toolStarted(event.callId, event.tool)
              : journal.toolFinished(event.callId),
          );
        if (
          event._tag === "SessionIdle" ||
          event._tag === "SessionResumed" ||
          event._tag === "SessionFinished"
        )
          yield* checkpoint(
            event._tag === "SessionIdle"
              ? journal.saveIdle(event.message, event.answeredOperator)
              : journal.saveIdle(Option.none(), false),
          );
        if (
          event._tag === "SessionStarted" &&
          event.session._tag === "ChildSession" &&
          Option.isSome(event.harnessSession)
        ) {
          const recovery = yield* Schema.encodeEffect(SavedChild)(
            SavedChild.make({
              session: {
                id: event.session.id,
                parentId: event.session.parentId,
                agent: event.session.agent,
                brain: event.session.brain,
              },
              usage: cumulativeUsage,
              harnessSession: event.harnessSession.value,
              worker: request.worker,
              machine: request.machine,
            }),
          ).pipe(Effect.orDie);
          yield* checkpoint(journal.saveSession(recovery, { beforePrompt: false }));
          yield* checkpoint(call.publish({ childSessionId: session.id, saved: recovery }));
        }
        if (event._tag === "SessionTokensUpdated") {
          cumulativeUsage = Option.some(event);
          const usage = yield* Schema.encodeEffect(ChildRequest.fields.usage)(cumulativeUsage).pipe(
            Effect.orDie,
          );
          yield* checkpoint(journal.saveUsage(usage));
        }
        if (event._tag === "TextOutput") {
          yield* checkpoint(call.output(`${event.text}\n`));
          yield* checkpoint(Effect.flatMap(call.retainedOutput, journal.saveOutput));
        }
        const recorded =
          event._tag === "SessionStarted" && !resumed
            ? SessionStarted.make({ ...event, prompt: Option.some(childRequest.prompt) })
            : event;
        yield* hub.event(recorded);
      });
    // These errors end the stream with the same report the child's result contains, so they are
    // ignored here.
    const forwarding = yield* child.events.pipe(
      Stream.runForEach(forward),
      Effect.catchTag(reservedReports, () => Effect.void),
      Effect.forkScoped,
    );
    const outcome = yield* untilAborted(
      child.result.pipe(
        Effect.tapError(recordInfrastructureFailure),
        Effect.map(Result.succeed),
        Effect.catchTag(reservedReports, (report) => Effect.succeed(Result.fail(report))),
      ),
      Effect.logInfo("Interrupting the child of an aborted tool call", {
        sessionId: session.id,
      }).pipe(Effect.andThen(child.interrupt)),
    );
    yield* Fiber.join(forwarding);
    yield* journal.holdEnded(session.id);
    if (resumed) yield* call.recovered(session.id);
    return yield* Result.match(outcome, {
      onFailure: (report) =>
        Effect.gen(function* () {
          const reserved: ReservedChildReport = {
            kind: Match.valueTags(report, {
              AgentResultError: () => "failed" as const,
              AgentCapacityError: () => "capacity" as const,
              AgentBlockedError: () => "blocked" as const,
              AgentQuestionError: () => "question" as const,
            }),
            message: report.message,
            resetsAt:
              report._tag === "AgentCapacityError"
                ? Option.map(report.resetsAt, DateTime.formatIso)
                : Option.none(),
          };
          yield* Effect.logInfo("Child session returned a reserved report", {
            sessionId: session.id,
            kind: reserved.kind,
            resetsAt: Option.getOrUndefined(reserved.resetsAt),
          });
          yield* call.reserved(session.id, reserved);
          yield* hub.event(SessionFinished.make({ session: child.session }));
          return Reserved.make({ sessionId: session.id, report });
        }),
      onSuccess: (result) =>
        Effect.logInfo("Child session returned its report", {
          sessionId: session.id,
          answeredOperator: result.answeredOperator,
        }).pipe(
          Effect.as(
            Reported.make({
              sessionId: session.id,
              report: result.message,
              answeredOperator: result.answeredOperator,
            }),
          ),
        ),
    });
  }).pipe(Effect.scoped);
  return yield* resumed
    ? runChild.pipe(
        Effect.catchIf(Schema.is(AgentSessionError), (error) => interrupted(error.message)),
      )
    : runChild;
}, Effect.scoped);
