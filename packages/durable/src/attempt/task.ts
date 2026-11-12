// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import type { Context as ChordContext } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  configure,
  type ConversationId,
  defineTask,
  type EntryId,
  type EntryRecord,
  type Extension,
  type NextTaskState,
  type RunningTask,
  type TaskId,
  type TaskRuntime,
  type ToolRegistration,
  ToolResultEntry,
  type Tx,
  UserEntry,
} from "@earendil-works/pi-durable";
import { assemblePrompt } from "@usine/agents/prompt";
import { piFailure } from "@usine/agents/pi/refusal";
import { AgentCapacityError, reportedOutcome, toAttemptFailure } from "@usine/agents/runtime";
import { ModelId } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import type { RunSpec } from "@usine/core/attempt/channel";
import {
  AgentFailure,
  type AttemptFailure,
  BlockedFailure,
  ChildSessionBudgetFailure,
  InfraFailure,
  ProviderCapacityFailure,
  QuestionFailure,
} from "@usine/core/attempt/failure";
import {
  ChildSessionBudget,
  ChildSessionCount,
  SessionIdle,
  SessionResumed,
} from "@usine/core/agent/session";
import { DateTime, Effect, Option, Result, Schema } from "effect";
import { durableError } from "../harness.ts";
import {
  type AttemptRecord,
  type AttemptResult,
  AttemptRecordDoc,
  type Hold,
  HoldDoc,
  RELEASE_GUIDANCE,
} from "./documents.ts";
import { assistantText, failedAssistantTimestamp } from "./events.ts";
import { completedOutcome, failedOutcome } from "./outcome.ts";
import { parentSession, resolveParent } from "./parent.ts";
import { parentSessionId } from "./sessions.ts";
import { type AttemptTaskInput, storedRequestOf } from "./request.ts";
import type { ExtensionServices } from "./services.ts";
import { hasPendingForwardedSteer } from "./steering.ts";
import { firstAccepted } from "./watch.ts";

/** The task's checkpoint: resolving the parent, or running one parent turn. */
export type AttemptCheckpoint =
  | { phase: "prepare" }
  | {
      phase: "run";
      parent: ConversationId;
      /** Turn 1 submits the assembled prompt; later turns submit operator guidance. */
      turn: number;
      message: string | null;
      requestId?: string;
    };

type Runtime = TaskRuntime<AttemptTaskInput, AttemptCheckpoint, AttemptResult, object>;
type NextState = NextTaskState<AttemptCheckpoint, AttemptResult>;

/** The task name of an Attempt's parent task, stored in every task record. */
export const ATTEMPT_TASK = "usine.attempt";

const call = <A>(operation: string, run: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => durableError(operation, cause) });

const commit = (
  runtime: Runtime,
  context: ChordContext,
  operation: string,
  change: (tx: Tx) => NextState | undefined | Promise<NextState | undefined>,
) => call(operation, () => runtime.commit((tx) => change(tx), context));

/**
 * Returns the failure for a child's stored report if the parent didn't relay one. A harness failure
 * maps to `AgentFailure`, which doesn't suppress the Item.
 */
const childReportFailure = ({
  message,
  kind,
  resetsAt,
}: NonNullable<AttemptRecord["childBlocker"]>): AttemptFailure => {
  if (kind === "infra") return InfraFailure.make({ message, cause: message });
  if (kind === "question") return QuestionFailure.make({ question: message });
  if (kind === "capacity")
    return ProviderCapacityFailure.make({
      message,
      resetsAt: Option.flatMap(Option.fromUndefinedOr(resetsAt), DateTime.make),
    });
  if (kind === "failed") return AgentFailure.make({ message });
  return BlockedFailure.make({ message });
};

const finalAnswer = Effect.fn("AttemptTask.finalAnswer")(function* (
  runtime: Runtime,
  context: ChordContext,
  parent: ConversationId,
  answer: EntryId,
) {
  const entry = yield* call("read the parent's answer", () =>
    runtime.entry(AssistantEntry, answer, context),
  );
  const text = entry === undefined ? Option.none<string>() : assistantText(entry);
  if (Option.isSome(text)) return text.value;
  const view = yield* call("read the parent's transcript", () => runtime.context(parent, context));
  for (const earlier of [...view.entries].reverse()) {
    const earlierText =
      earlier.kind === AssistantEntry.kind ? assistantText(earlier) : Option.none();
    if (Option.isSome(earlierText)) return earlierText.value;
  }
  return "Pi session completed";
});

/**
 * Whether `answer` replies to an operator message or steer: the newest user entry before it isn't
 * `ownInput`, and no tool result is between them.
 */
const repliesToOperator = (
  entries: ReadonlyArray<EntryRecord>,
  answer: EntryId,
  ownInput: Option.Option<EntryId>,
): boolean => {
  for (const entry of [...entries].reverse()) {
    if (entry.id >= answer) continue;
    if (entry.kind === ToolResultEntry.kind) return false;
    if (entry.kind === UserEntry.kind) return !Option.contains(ownInput, entry.id);
  }
  return false;
};

/**
 * Classifies the error that ended a parent turn as a child's, and returns it if it is a capacity
 * refusal. A stated wait counts from the failed assistant entry, or from now if there is none.
 */
const parentRefusal = Effect.fn("AttemptTask.parentRefusal")(function* (
  runtime: Runtime,
  context: ChordContext,
  parent: ConversationId,
  attemptId: AttemptId,
  errorMessage: string,
) {
  const view = yield* call("read the parent's transcript", () => runtime.context(parent, context));
  const timestamp = yield* Option.match(failedAssistantTimestamp(view.entries), {
    onSome: Effect.succeed,
    onNone: () => Effect.map(DateTime.now, DateTime.toEpochMillis),
  });
  const failure = piFailure(parentSessionId(attemptId), { errorMessage, timestamp });
  if (!Schema.is(AgentCapacityError)(failure)) return Option.none<AgentCapacityError>();
  yield* Effect.logWarning("Pi parent turn ended on a provider capacity refusal or usage limit", {
    attemptId,
    resetsAt: Option.getOrUndefined(Option.map(failure.resetsAt, DateTime.formatIso)),
  });
  return Option.some(failure);
});

/** Whether the parent is paused, has pending guidance, or is under a Hold. */
const supervised = (hold: Readonly<Hold>, attemptId: AttemptId): boolean =>
  hold.paused || hold.guidance.length > 0 || hold.held.includes(parentSessionId(attemptId));

const budgetExceeded = (runtime: Runtime, context: ChordContext, attemptId: AttemptId) =>
  call("watch the child-session budget", async (signal) => {
    const scoped = withAbortSignal(signal, context);
    const watch = await runtime.watchDoc(AttemptRecordDoc, attemptId, scoped);
    if (watch === undefined) throw new Error(`Attempt ${attemptId} has no durable record`);
    const record = await firstAccepted(
      watch,
      (value) => value.childBudgetExceeded !== null,
      scoped,
    );
    return record.childBudgetExceeded;
  });

/**
 * Builds the `usine.attempt` task, which submits the assembled prompt and then operator guidance
 * one turn at a time. Each turn is submitted exactly once across restarts.
 */
export const attemptTask = (
  services: ExtensionServices,
  selection: () => { readonly extension: Extension; readonly tool: ToolRegistration },
) => {
  const prepare = Effect.fn("AttemptTask.prepare")(function* (
    task: RunningTask<AttemptTaskInput, { phase: "prepare" }, AttemptResult>,
    runtime: Runtime,
    context: ChordContext,
  ) {
    const request = yield* storedRequestOf(task.input);
    const spec = request.spec;
    yield* Effect.annotateCurrentSpan({
      attemptId: spec.attemptId,
      taskId: task.id,
      sessionId: parentSessionId(spec.attemptId),
    });
    const resolved = yield* resolveParent(
      services.parents,
      spec,
      Option.some(parentSessionId(spec.attemptId)),
    ).pipe(Effect.result);
    if (Result.isFailure(resolved)) {
      yield* Effect.logError("Pi parent could not start", {
        attemptId: spec.attemptId,
        errorTag: resolved.failure._tag,
        message: resolved.failure.message,
      });
      const outcome = resolved.failure.pipe(toAttemptFailure, failedOutcome);
      yield* commit(runtime, context, "record the failed start", () => outcome);
      return;
    }
    const { ref, model, pool, endpoint } = resolved.success;
    const { extension, tool } = selection();
    let parent = Option.none<ConversationId>();
    yield* commit(runtime, context, "create the parent conversation", async (tx) => {
      const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
      const conversation =
        existing ?? (await tx.createConversation({ ownership: { kind: "task", taskId: task.id } }));
      if (existing === undefined) {
        await configure(tx, conversation.id, {
          model: ref,
          thinkingLevel: spec.parentEffort,
          extensions: [extension],
          tools: [tool],
        });
      }
      await tx.doc(HoldDoc, task.id);
      const record = await tx.doc(AttemptRecordDoc, spec.attemptId, null);
      record.started = true;
      record.parentModel = model;
      record.parentPool = pool;
      record.parentEndpoint = Option.getOrNull(endpoint);
      record.parentConversation = conversation.id;
      parent = Option.some(conversation.id);
      return {
        status: "running",
        checkpoint: { phase: "run", parent: conversation.id, turn: 1, message: null },
      };
    });
    yield* Effect.logInfo("Created the Pi parent conversation", {
      attemptId: spec.attemptId,
      parentConversation: Option.getOrUndefined(parent),
      model,
    });
  });

  /** Queues a parent lifecycle event that has no parent entry, such as waiting on the operator. */
  const announce = Effect.fn("AttemptTask.announce")(function* (
    spec: RunSpec,
    taskId: TaskId,
    runtime: Runtime,
    context: ChordContext,
    lifecycle: "Idle" | "Resumed",
  ) {
    const record = yield* call("read the Attempt record", () =>
      runtime.snapshot(AttemptRecordDoc, spec.attemptId, context),
    );
    const model = record?.parentModel ?? null;
    if (model === null || record === undefined) {
      return yield* Effect.logWarning(
        "The parent has no resolved model; its lifecycle event is dropped",
        { lifecycle },
      );
    }
    const session = parentSession(spec, ModelId.make(model), record);
    const hub = yield* services.hubs.hub(spec.attemptId, taskId);
    yield* services.hubs.event(
      hub,
      lifecycle === "Idle" ? SessionIdle.make({ session }) : SessionResumed.make({ session }),
    );
  });

  /**
   * Waits while the parent is supervised, then commits the oldest operator guidance, or
   * `RELEASE_GUIDANCE` if there is none, as its next turn.
   */
  const awaitGuidance = Effect.fn("AttemptTask.awaitGuidance")(function* (
    task: RunningTask<
      AttemptTaskInput,
      Extract<AttemptCheckpoint, { phase: "run" }>,
      AttemptResult
    >,
    runtime: Runtime,
    context: ChordContext,
  ) {
    const { spec } = yield* storedRequestOf(task.input);
    const { parent, turn } = task.state.checkpoint;
    const parentId = parentSessionId(spec.attemptId);
    const released = (hold: Readonly<Hold>) => !hold.paused && !hold.held.includes(parentId);
    const current = yield* call("read the Hold", () => runtime.snapshot(HoldDoc, task.id, context));
    // Pending guidance resumes the parent immediately, so `Idle` is not announced.
    const waits = (current?.guidance.length ?? 0) === 0;
    if (waits) yield* announce(spec, task.id, runtime, context, "Idle");
    while (true) {
      yield* call("wait for operator guidance", async (signal) => {
        const scoped = withAbortSignal(signal, context);
        const watch = await runtime.watchDoc(HoldDoc, task.id, scoped);
        if (watch === undefined) throw new Error("The attempt task has no Hold document");
        return firstAccepted(watch, (hold) => hold.guidance.length > 0 || released(hold), scoped);
      });
      let resumed = Option.none<"Guidance" | "Release">();
      yield* commit(runtime, context, "take operator guidance", async (tx) => {
        const hold = await tx.doc(HoldDoc, task.id);
        const [next, ...rest] = hold.guidance;
        if (next === undefined && !released(hold)) return undefined;
        hold.guidance = rest;
        hold.paused = false;
        resumed = Option.some(next === undefined ? "Release" : "Guidance");
        return {
          status: "running",
          checkpoint: {
            phase: "run",
            parent,
            turn: turn + 1,
            message: next?.message ?? RELEASE_GUIDANCE,
            requestId: next?.requestId ?? `${ATTEMPT_TASK}:${task.id}:turn:${turn + 1}`,
          },
        };
      });
      if (Option.isSome(resumed)) {
        yield* Effect.logInfo("Resuming the Pi parent", {
          turn: turn + 1,
          resumedBy: resumed.value,
        });
        if (waits) yield* announce(spec, task.id, runtime, context, "Resumed");
        return;
      }
    }
  });

  const run = Effect.fn("AttemptTask.run")(function* (
    task: RunningTask<
      AttemptTaskInput,
      Extract<AttemptCheckpoint, { phase: "run" }>,
      AttemptResult
    >,
    runtime: Runtime,
    context: ChordContext,
  ) {
    const request = yield* storedRequestOf(task.input);
    const spec = request.spec;
    const { parent, turn, message } = task.state.checkpoint;
    yield* Effect.annotateCurrentSpan({
      attemptId: spec.attemptId,
      taskId: task.id,
      sessionId: parentSessionId(spec.attemptId),
      turn,
    });
    const conversation = yield* call("open the parent conversation", () =>
      runtime.conversation(parent, context),
    );
    if (conversation === undefined) {
      return yield* Effect.die(new Error(`Parent conversation ${parent} is missing`));
    }
    const content =
      message ??
      assemblePrompt({
        baseCommit: spec.baseCommit,
        repository: spec.repository,
        payload: spec.payload,
        agent: spec.agent.name,
        persona: spec.agent.persona,
        task: spec.task,
        resume: spec.resume,
        conflictingSalvage: spec.conflictingSalvage,
      });
    const submission = yield* call("submit the parent turn", () =>
      conversation.submit(
        {
          type: "input",
          content,
          requestId: task.state.checkpoint.requestId ?? `${ATTEMPT_TASK}:${task.id}:turn:${turn}`,
        },
        context,
      ),
    );
    yield* Effect.logInfo("Submitted a Pi parent turn", { turn, submissionId: submission.id });
    const ended = yield* Effect.raceFirst(
      call("wait for the parent turn", (signal) =>
        submission.wait(withAbortSignal(signal, context)),
      ).pipe(Effect.map((settled) => ({ _tag: "Settled", settled }) as const)),
      budgetExceeded(runtime, context, spec.attemptId).pipe(
        Effect.map((exceeded) => ({ _tag: "BudgetExceeded", exceeded }) as const),
      ),
    );
    if (ended._tag === "BudgetExceeded") {
      const attempted = ended.exceeded?.attempted ?? spec.maxChildren + 1;
      yield* Effect.logWarning(
        "Stopping the Pi parent after its child-session budget was exceeded",
        {
          attemptedChildren: attempted,
          maxChildren: spec.maxChildren,
        },
      );
      // A failed outcome aborts the task's remaining work, including children.
      const outcome = failedOutcome(
        ChildSessionBudgetFailure.make({
          attemptedChildren: ChildSessionCount.make(attempted),
          maxChildren: ChildSessionBudget.make(spec.maxChildren),
        }),
      );
      yield* commit(runtime, context, "record the exceeded budget", () => outcome);
      return;
    }
    const settled = ended.settled;
    if (settled.type === "input" && settled.status === "done") {
      const answer = yield* finalAnswer(runtime, context, parent, settled.answer);
      const view = yield* call("read the parent's transcript", () =>
        runtime.context(parent, context),
      );
      const answeredOperator = repliesToOperator(
        view.entries,
        settled.answer,
        turn === 1 || message === RELEASE_GUIDANCE ? Option.some(settled.entry) : Option.none(),
      );
      const record = yield* call("read the Attempt record", () =>
        runtime.snapshot(AttemptRecordDoc, spec.attemptId, context),
      );
      const own = Option.map(reportedOutcome(Option.none(), answer), toAttemptFailure);
      const relayed = Option.fromNullishOr(record?.childBlocker);
      if (Option.isNone(own) && Option.isSome(relayed)) {
        yield* Effect.logWarning("Pi parent finished without relaying its child's report", {
          childSessionId: relayed.value.sessionId,
          kind: relayed.value.kind ?? "blocked",
        });
      }
      // A child's infrastructure failure or provider refusal outranks the parent's report, which
      // can describe the refusal as a blocker.
      const overriding = Option.filter(
        relayed,
        ({ kind }) => kind === "infra" || kind === "capacity",
      );
      if (Option.isSome(overriding) && Option.isSome(own))
        yield* Effect.logInfo("Child's report replaces the Pi parent's own report", {
          childSessionId: overriding.value.sessionId,
          kind: overriding.value.kind,
          parentReport: own.value._tag,
        });
      const outcome = Option.isSome(overriding)
        ? Option.some(childReportFailure(overriding.value))
        : Option.orElse(own, () => Option.map(relayed, childReportFailure));
      const terminal = Option.match(outcome, {
        onNone: () => completedOutcome(answer, answeredOperator),
        onSome: failedOutcome,
      });
      const hub = yield* services.hubs.hub(spec.attemptId, task.id);
      let finished = false;
      while (true) {
        let pending = false;
        yield* hub.routing.withPermits(1)(
          commit(runtime, context, "record the parent's answer", async (tx) => {
            pending = hasPendingForwardedSteer(
              await tx.doc(AttemptRecordDoc, spec.attemptId, null),
            );
            if (pending || supervised(await tx.doc(HoldDoc, task.id), spec.attemptId))
              return undefined;
            finished = true;
            return terminal;
          }),
        );
        if (!pending) break;
        yield* Effect.logInfo("Waiting for the child's receipt before completing the attempt", {
          attemptId: spec.attemptId,
        });
        yield* call("wait for forwarded steers", async (signal) => {
          const scoped = withAbortSignal(signal, context);
          const watch = await runtime.watchDoc(AttemptRecordDoc, spec.attemptId, scoped);
          if (watch === undefined) throw new Error("The attempt has no durable record");
          return firstAccepted(watch, (record) => !hasPendingForwardedSteer(record), scoped);
        });
      }
      if (finished) {
        yield* Effect.logInfo("Pi parent finished", {
          turn,
          answeredOperator,
          report: Option.match(outcome, { onNone: () => "none", onSome: ({ _tag }) => _tag }),
        });
        return;
      }
      yield* Effect.logInfo(
        "Pi parent answered under operator supervision; holding its answer for the operator",
        { turn, answeredOperator },
      );
      return yield* awaitGuidance(task, runtime, context);
    }
    if (settled.status === "unanswered" && settled.reason === "aborted") {
      const hold = yield* call("read the Hold", () => runtime.snapshot(HoldDoc, task.id, context));
      if (hold !== undefined && supervised(hold, spec.attemptId)) {
        yield* Effect.logInfo("Pi parent turn was interrupted; waiting for operator guidance", {
          turn,
        });
        return yield* awaitGuidance(task, runtime, context);
      }
    }
    const reason = settled.status === "unanswered" ? settled.reason : settled.status;
    yield* Effect.logError("Pi parent turn ended without an answer", { turn, reason });
    const refusal =
      settled.status === "unanswered" &&
      settled.reason === "model_error" &&
      Schema.is(Schema.String)(settled.detail)
        ? yield* parentRefusal(runtime, context, parent, spec.attemptId, settled.detail)
        : Option.none<AgentCapacityError>();
    const outcome = failedOutcome(
      Option.match(refusal, {
        onSome: toAttemptFailure,
        onNone: () =>
          InfraFailure.make({
            message: `The Pi parent's turn ended without an answer: ${reason}`,
            cause: settled.status === "unanswered" ? (settled.detail ?? reason) : reason,
          }),
      }),
    );
    yield* commit(runtime, context, "record the unanswered turn", () => outcome);
  });

  return defineTask<AttemptTaskInput, AttemptCheckpoint, AttemptResult>({
    name: ATTEMPT_TASK,
    version: 1,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: (task, runtime, context) =>
        services.run(prepare(task, runtime, context), context.abortSignal),
      run: (task, runtime, context) =>
        services.run(run(task, runtime, context), context.abortSignal),
    },
    abort: (task, runtime, context) =>
      services.run(
        Effect.gen(function* () {
          const { spec } = yield* storedRequestOf(task.input);
          const record = yield* call("read the Attempt record", () =>
            runtime.snapshot(AttemptRecordDoc, spec.attemptId, context),
          ).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                "Could not read the aborted Attempt's record; ending it as canceled",
                {
                  attemptId: spec.attemptId,
                  message: error.message,
                },
              ),
            ),
            Effect.orElseSucceed(() => undefined),
          );
          const storageFailure = Option.fromUndefinedOr(record?.storageFailure);
          const outcome = Option.match(storageFailure, {
            onNone: (): NextState => ({
              status: "terminal",
              outcome: { status: "aborted" },
            }),
            onSome: (message) => failedOutcome(InfraFailure.make({ message, cause: message })),
          });
          yield* commit(runtime, context, "record the abort", () => outcome);
          yield* Option.match(storageFailure, {
            onNone: () => Effect.logInfo("Attempt task aborted", { taskId: task.id }),
            onSome: (message) =>
              Effect.logError("Attempt task failed: its parent conversation could not be read", {
                taskId: task.id,
                attemptId: spec.attemptId,
                cause: message,
              }),
          });
        }).pipe(Effect.withSpan("AttemptTask.abort")),
        context.abortSignal,
      ),
  });
};
