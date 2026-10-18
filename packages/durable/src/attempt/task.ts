import type { Context as ChordContext } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  configure,
  type ConversationId,
  defineTask,
  type EntryId,
  type Extension,
  type NextTaskState,
  type RunningTask,
  type TaskRuntime,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { assemblePrompt } from "@usine/agents/prompt";
import { reportedOutcome, toAttemptFailure } from "@usine/agents/runtime";
import type { AttemptId } from "@usine/core/attempt";
import {
  AgentFailure,
  type AttemptFailure,
  ChildSessionBudgetFailure,
  InfraFailure,
  QuestionFailure,
} from "@usine/core/attempt/failure";
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { Effect, Option, Result } from "effect";
import { durableError } from "../harness.ts";
import { type AttemptRecord, type AttemptResult, AttemptRecordDoc, HoldDoc } from "./documents.ts";
import { assistantText } from "./events.ts";
import { completedOutcome, failedOutcome } from "./outcome.ts";
import { parentSessionId, resolveParent } from "./parent.ts";
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

/** The failure a child's recorded report ends the Attempt with when the parent did not relay one. */
const childReportFailure = ({
  message,
  kind,
}: NonNullable<AttemptRecord["childBlocker"]>): AttemptFailure =>
  kind === "question" ? new QuestionFailure({ question: message }) : new AgentFailure({ message });

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
 * prompt, then operator guidance after an interrupt. The submission's request
 * id makes each turn exactly-once across restarts.
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

  const awaitGuidance = Effect.fn("AttemptTask.awaitGuidance")(function* (
    task: RunningTask<
      AttemptTaskInput,
      Extract<AttemptCheckpoint, { phase: "run" }>,
      AttemptResult
    >,
    runtime: Runtime,
    context: ChordContext,
  ) {
    const { parent, turn } = task.state.checkpoint;
    while (true) {
      yield* call("wait for operator guidance", async (signal) => {
        const scoped = withAbortSignal(signal, context);
        const watch = await runtime.watchDoc(HoldDoc, task.id, scoped);
        if (watch === undefined) throw new Error("The Attempt task has no Hold document");
        return firstAccepted(watch, (hold) => hold.guidance.length > 0, scoped);
      });
      let resumed = false;
      yield* commit(runtime, context, "take operator guidance", async (tx) => {
        const hold = await tx.doc(HoldDoc, task.id);
        const [next, ...rest] = hold.guidance;
        if (next === undefined) return undefined;
        hold.guidance = rest;
        hold.paused = false;
        resumed = true;
        return {
          status: "running",
          checkpoint: { phase: "run", parent, turn: turn + 1, message: next },
        };
      });
      if (resumed) {
        yield* Effect.logInfo("Resuming the Pi parent with operator guidance", { turn: turn + 1 });
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
        const hold = await tx.doc(HoldDoc, task.id);
        if (hold.paused || hold.guidance.length > 0) return undefined;
        finished = true;
        return Option.match(outcome, {
          onNone: () => completedOutcome(answer),
          onSome: failedOutcome,
        });
      });
      if (finished) {
        yield* Effect.logInfo("Pi parent finished", {
          turn,
          report: Option.match(outcome, { onNone: () => "none", onSome: ({ _tag }) => _tag }),
        });
        return;
      }
      yield* Effect.logInfo(
        "Pi parent answered while interrupted; holding its answer for the operator",
        {
          turn,
        },
      );
      return yield* awaitGuidance(task, runtime, context);
    }
    if (settled.status === "unanswered" && settled.reason === "aborted") {
      const hold = yield* call("read the Hold", () => runtime.snapshot(HoldDoc, task.id, context));
      if (hold !== undefined && (hold.paused || hold.guidance.length > 0)) {
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
