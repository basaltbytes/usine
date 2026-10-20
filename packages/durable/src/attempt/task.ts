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
import { reportedOutcome, toAttemptFailure } from "@usine/agents/runtime";
import { ModelId } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import type { RunSpec } from "@usine/core/attempt/channel";
import {
  AgentFailure,
  type AttemptFailure,
  BlockedFailure,
  ChildSessionBudgetFailure,
  InfraFailure,
  QuestionFailure,
} from "@usine/core/attempt/failure";
import {
  ChildSessionBudget,
  ChildSessionCount,
  SessionIdle,
  SessionResumed,
} from "@usine/core/agent/session";
import { Effect, Option, Result } from "effect";
import { durableError } from "../harness.ts";
import {
  type AttemptRecord,
  type AttemptResult,
  AttemptRecordDoc,
  type Hold,
  HoldDoc,
  RELEASE_GUIDANCE,
} from "./documents.ts";
import { assistantText } from "./events.ts";
import { completedOutcome, failedOutcome } from "./outcome.ts";
import { parentSession, parentSessionId, resolveParent } from "./parent.ts";
import { type AttemptTaskInput, storedRequestOf } from "./request.ts";
import type { ExtensionServices } from "./services.ts";
import { firstAccepted } from "./watch.ts";

/** Where the Attempt's task is: resolving its parent, or running one parent turn. */
export type AttemptCheckpoint =
  | { phase: "prepare" }
  | {
      phase: "run";
      parent: ConversationId;
      /** Turn 1 submits the assembled prompt; a later turn submits operator guidance. */
      turn: number;
      message: string | null;
    };

type Runtime = TaskRuntime<AttemptTaskInput, AttemptCheckpoint, AttemptResult, object>;
type NextState = NextTaskState<AttemptCheckpoint, AttemptResult>;

/** The name of the task that runs one Attempt's parent; stored in every task record. */
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
 * The failure a child's recorded report ends the Attempt with when the parent
 * did not relay one. A harness failure posted nothing on the Item, so it ends
 * the Attempt with `AgentFailure`, which does not hold the Item.
 */
const childReportFailure = ({
  message,
  kind,
}: NonNullable<AttemptRecord["childBlocker"]>): AttemptFailure => {
  if (kind === "question") return new QuestionFailure({ question: message });
  if (kind === "failed") return new AgentFailure({ message });
  return new BlockedFailure({ message });
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
 * Whether the answer replies to an operator message or a steer: the newest
 * user input before it is not the turn's own input, the Attempt's prompt or
 * the release guidance, and no tool result lies between them.
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

/** The operator holds the parent: it is interrupted, has guidance waiting, or is under a Hold. */
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
 * Builds the `usine.attempt` task. It resolves the parent's model, creates the
 * parent conversation it owns, and submits one turn at a time: the assembled
 * prompt, then operator guidance after an interrupt or under a Hold. The
 * submission's request id makes each turn exactly-once across restarts.
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
    const resolved = yield* resolveParent(runtime.models, services.defaultModel, spec).pipe(
      Effect.result,
    );
    if (Result.isFailure(resolved)) {
      yield* Effect.logError("Pi parent could not start", {
        attemptId: spec.attemptId,
        errorTag: resolved.failure._tag,
        message: resolved.failure.message,
      });
      yield* commit(runtime, context, "record the failed start", () =>
        failedOutcome(toAttemptFailure(resolved.failure)),
      );
      return;
    }
    const { ref, model } = resolved.success;
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
      record.parentModel = model;
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

  /** Queues a parent lifecycle event for the relay; no parent entry stands for waiting on the operator. */
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
    if (model === null) {
      return yield* Effect.logWarning(
        "The parent has no resolved model; its lifecycle event is dropped",
        { lifecycle },
      );
    }
    const session = parentSession(spec, ModelId.make(model));
    const hub = yield* services.hubs.hub(spec.attemptId, taskId);
    yield* services.hubs.event(
      hub,
      lifecycle === "Idle" ? new SessionIdle({ session }) : new SessionResumed({ session }),
    );
  });

  /**
   * Waits while the operator supervises the parent, then commits its next
   * turn: the oldest operator guidance, or the release guidance once the
   * operator ended the pause and the Hold without a message.
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
    // Guidance that is already waiting resumes the parent at once, so it never waits.
    const waits = (current?.guidance.length ?? 0) === 0;
    if (waits) yield* announce(spec, task.id, runtime, context, "Idle");
    while (true) {
      yield* call("wait for operator guidance", async (signal) => {
        const scoped = withAbortSignal(signal, context);
        const watch = await runtime.watchDoc(HoldDoc, task.id, scoped);
        if (watch === undefined) throw new Error("The Attempt task has no Hold document");
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
          checkpoint: { phase: "run", parent, turn: turn + 1, message: next ?? RELEASE_GUIDANCE },
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
        { type: "input", content, requestId: `${ATTEMPT_TASK}:${task.id}:turn:${turn}` },
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
      // A failed outcome aborts the work the task still owns, children included.
      yield* commit(runtime, context, "record the exceeded budget", () =>
        failedOutcome(
          new ChildSessionBudgetFailure({
            attemptedChildren: ChildSessionCount.make(attempted),
            maxChildren: ChildSessionBudget.make(spec.maxChildren),
          }),
        ),
      );
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
      const outcome = Option.orElse(own, () => Option.map(relayed, childReportFailure));
      let finished = false;
      yield* commit(runtime, context, "record the parent's answer", async (tx) => {
        if (supervised(await tx.doc(HoldDoc, task.id), spec.attemptId)) return undefined;
        finished = true;
        return Option.match(outcome, {
          onNone: () => completedOutcome(answer, answeredOperator),
          onSome: failedOutcome,
        });
      });
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
    yield* commit(runtime, context, "record the unanswered turn", () =>
      failedOutcome(
        new InfraFailure({
          message: `The Pi parent's turn ended without an answer: ${reason}`,
          cause: settled.status === "unanswered" ? (settled.detail ?? reason) : reason,
        }),
      ),
    );
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
          yield* commit(runtime, context, "record the abort", () =>
            Option.match(storageFailure, {
              onNone: (): NextState => ({ status: "terminal", outcome: { status: "aborted" } }),
              onSome: (message) => failedOutcome(new InfraFailure({ message, cause: message })),
            }),
          );
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
