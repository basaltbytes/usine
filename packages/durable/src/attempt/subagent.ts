// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { copyJson, type Context as ChordContext } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type Tx,
} from "@earendil-works/pi-durable";
import { ChildSessionBudgetExceededError, reportText } from "@usine/agents/runtime";
import type { AttemptId } from "@usine/core/attempt";
import { Effect, Match, Option } from "effect";
import { durableError } from "../harness.ts";
import { SubagentDoc } from "./child.ts";
import { delegate, type DelegationOutcome } from "./delegation/delegation.ts";
import type { ChildBlocker, DelegationDetails, DelegationJournal } from "./delegation/journal.ts";
import { type AttemptRecord, AttemptRecordDoc, HoldDoc } from "./documents.ts";
import { storedRequestOf } from "./request.ts";
import type { ExtensionServices } from "./services.ts";
import { firstAccepted } from "./watch.ts";

/** The name of the parent's only tool. */
export const SUBAGENT_TOOL = "subagent";

const call = <A>(operation: string, run: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => durableError(operation, cause) });

const aborted = (context: ChordContext): Effect.Effect<void> =>
  Option.match(Option.fromNullishOr(context.abortSignal), {
    onNone: () =>
      Effect.logWarning(
        "pi-durable supplied no abort signal; the child outlives only its scope",
      ).pipe(Effect.andThen(Effect.never)),
    onSome: (signal) =>
      Effect.callback<void>((resume) => {
        const onAbort = () => resume(Effect.void);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
      }),
  });

type StoredBlocker = NonNullable<AttemptRecord["childBlocker"]>;

/** A stored blocker without a `kind` predates the other kinds and is a blocker. */
const childBlocker = ({ sessionId, message, kind }: StoredBlocker): ChildBlocker => ({
  sessionId,
  message,
  kind: kind ?? "blocked",
});

/**
 * A journal over one `subagent` call. The call's task keys the delegation's `SubagentDoc`, its
 * running output and details are the delegation's, and its abort ends the delegation.
 */
const toolJournal = (
  api: ToolExecutionApi<DelegationDetails>,
  context: ChordContext,
  attemptId: AttemptId,
  attemptTaskId: TaskId,
): DelegationJournal => {
  const commit = <A>(operation: string, change: (tx: Tx) => Promise<A>) =>
    call(operation, () => api.commit(change, context));
  const attempt = (tx: Tx) => tx.doc(AttemptRecordDoc, attemptId, null);
  const delegation = (tx: Tx) => tx.doc(SubagentDoc, api.taskId);
  const hold = (operation: string) =>
    call(operation, () => api.snapshot(HoldDoc, attemptTaskId, context));
  return {
    start: (budget, supersedes) =>
      commit("count the child spawn", async (tx) => {
        const record = await attempt(tx);
        const saved = await delegation(tx);
        const progress = {
          output: saved.output,
          saved: Option.map(Option.fromNullOr(saved.saved), (value) => copyJson(value)),
          idle: Option.fromNullishOr(saved.idle),
          continuations: [...(saved.continuations ?? [])],
          inFlight: (saved.inFlight ?? []).map(({ callId, tool }) => ({ callId, tool })),
          prompted: saved.prompted ?? true,
        };
        if (saved.count !== null)
          return { count: saved.count, resumed: true, progress, superseded: Option.none() };
        record.children += 1;
        saved.count = record.children;
        if (record.children > budget) {
          record.childBudgetExceeded ??= { attempted: record.children, max: budget };
          return { count: record.children, resumed: false, progress, superseded: Option.none() };
        }
        const superseded = Option.filter(Option.fromNullOr(record.childBlocker), (blocker) =>
          supersedes(childBlocker(blocker)),
        );
        if (Option.isSome(superseded)) record.childBlocker = null;
        return {
          count: record.children,
          resumed: false,
          progress,
          superseded: Option.map(superseded, ({ sessionId }) => sessionId),
        };
      }),
    recordBlocker: (blocker, keeps) =>
      commit(
        blocker.kind === "infra"
          ? "record the child's infrastructure failure"
          : "record the child's report",
        async (tx) => {
          const record = await attempt(tx);
          if (record.childBlocker !== null && keeps(childBlocker(record.childBlocker)))
            return false;
          record.childBlocker = { ...blocker };
          return true;
        },
      ),
    clearBlocker: (accept) =>
      commit("clear the recovered child's infrastructure failure", async (tx) => {
        const record = await attempt(tx);
        if (record.childBlocker === null || !accept(childBlocker(record.childBlocker)))
          return false;
        record.childBlocker = null;
        return true;
      }),
    queuedInputs: (sessionId) =>
      call("restore the child's operator inputs", () =>
        api.snapshot(AttemptRecordDoc, attemptId, context),
      ).pipe(
        Effect.map((record) =>
          (record?.queuedInputs ?? []).flatMap((input) =>
            "child" in input && input.child === sessionId
              ? [{ inputSequence: input.inputSequence, intervention: input.intervention }]
              : [],
          ),
        ),
      ),
    supervision: (sessionId) =>
      hold("restore the child's supervision").pipe(
        Effect.map((current) => ({
          held: current?.held.includes(sessionId) ?? false,
          paused: current?.pausedChildren?.includes(sessionId) ?? false,
        })),
      ),
    holdEnded: (sessionId) =>
      call("wait for the child's Hold to end", async (signal) => {
        const scoped = withAbortSignal(signal, context);
        const watch = await api.watchDoc(HoldDoc, attemptTaskId, scoped);
        if (watch === undefined) return;
        await firstAccepted(watch, (current) => !current.held.includes(sessionId), scoped);
      }),
    releaseSupervision: (sessionId) =>
      commit("clear the interrupted child's supervision", async (tx) => {
        const current = await tx.doc(HoldDoc, attemptTaskId);
        current.held = current.held.filter((id) => id !== sessionId);
        current.pausedChildren = (current.pausedChildren ?? []).filter((id) => id !== sessionId);
      }),
    saveSession: (saved, { beforePrompt }) =>
      commit(
        beforePrompt ? "save the child before its first prompt" : "save the child's conversation",
        async (tx) => {
          const record = await delegation(tx);
          if (beforePrompt && record.saved === null) record.prompted = false;
          record.saved = saved;
        },
      ),
    savePrompted: commit("save the child's prompt receipt", async (tx) => {
      const record = await delegation(tx);
      record.prompted = true;
    }),
    saveContinuations: (timestamps) =>
      commit("save the child's continuation history", async (tx) => {
        const record = await delegation(tx);
        record.continuations = [...timestamps];
      }),
    saveUsage: (usage) =>
      commit("save the child's cumulative usage", async (tx) => {
        const record = await delegation(tx);
        if (record.saved !== null) record.saved.usage = usage;
      }),
    toolStarted: (callId, tool) =>
      commit("save the child's in-flight tool calls", async (tx) => {
        const record = await delegation(tx);
        record.inFlight = [
          ...(record.inFlight ?? []).filter((call) => call.callId !== callId),
          { callId, tool },
        ];
      }),
    toolFinished: (callId) =>
      commit("save the child's in-flight tool calls", async (tx) => {
        const record = await delegation(tx);
        record.inFlight = (record.inFlight ?? []).filter((call) => call.callId !== callId);
      }),
    saveIdle: (report) =>
      commit("save the child's idle report", async (tx) => {
        const record = await delegation(tx);
        record.idle = Option.getOrNull(report);
      }),
    output: (chunk) =>
      Effect.try({
        try: () => api.output(chunk),
        catch: (cause) => durableError("record the child's output", cause),
      }),
    saveOutput: Effect.suspend(() => {
      const output = api.retainedOutput().text;
      return commit("save the child's partial output", async (tx) => {
        const record = await delegation(tx);
        record.output = output;
      });
    }),
    retainedOutput: Effect.sync(() => api.retainedOutput().text),
    publish: (details) =>
      call(
        details.saved === undefined
          ? "publish the child's id"
          : "publish the saved child conversation",
        () => api.details(details, context),
      ),
    aborted: aborted(context),
  };
};

/** Maps a delegation's outcome to the tool result the Pi parent reads. */
const toolResult = (outcome: DelegationOutcome) =>
  Match.valueTags(outcome, {
    Reported: ({ report }) =>
      Effect.succeed<ToolExecutionResult<DelegationDetails>>({
        output: [{ type: "text", text: report }],
      }),
    Reserved: ({ report }) =>
      Effect.succeed<ToolExecutionResult<DelegationDetails>>({
        output: [{ type: "text", text: reportText(report) }],
      }),
    Interrupted: ({ sessionId, reason, output }) =>
      Effect.succeed<ToolExecutionResult<DelegationDetails>>({
        output: [{ type: "text", text: output }],
        isError: true,
        diagnostics: [
          {
            severity: "error",
            code: "interrupted",
            message: `Tool subagent was interrupted: ${reason}`,
          },
        ],
        details: { childSessionId: sessionId },
      }),
    BudgetExceeded: ({ attempted, max }) =>
      Effect.fail(
        ChildSessionBudgetExceededError.make({
          attemptedChildren: attempted,
          maxChildren: max,
          message: `Attempt tried to spawn child ${attempted} after reaching its ${max}-child budget`,
        }),
      ),
  });

/**
 * Builds the `subagent` tool, which runs one task in a child of the Agent's harness and returns the
 * child's report. A replay continues the saved child conversation in the retained checkout.
 */
export const subagentTool = (services: ExtensionServices) => {
  const spawn = Effect.fn("Subagent.spawn")(function* (
    task: string,
    api: ToolExecutionApi<DelegationDetails>,
    context: ChordContext,
  ) {
    const owner = yield* call("find the parent's Attempt task", () =>
      api.commit(async (tx) => {
        const conversation = await tx.conversation(api.conversationId);
        if (conversation?.owner === undefined) return undefined;
        const record = await tx.task(conversation.owner.taskId);
        return record === undefined ? undefined : { taskId: record.id, input: record.input };
      }, context),
    );
    if (owner === undefined) {
      return yield* Effect.die(
        new Error("The subagent tool runs only in an attempt's parent conversation"),
      );
    }
    const { spec } = yield* storedRequestOf(owner.input);
    const hub = yield* services.hubs.hub(spec.attemptId, owner.taskId);
    services.hubs.bindParent(hub, api.conversationId);
    const outcome = yield* delegate(services, {
      spec,
      hub,
      journal: toolJournal(api, context, spec.attemptId, owner.taskId),
      assignment: task,
    });
    return yield* toolResult(outcome);
  });

  return defineTool({
    name: SUBAGENT_TOOL,
    description:
      "Delegate to the configured isolated child agent and wait for its report. The runtime includes the rendered loop task unchanged; task supplies supplemental context or a focused assignment within it.",
    parameters: Type.Object(
      { task: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    replay: "safe",
    execute: (args, api: ToolExecutionApi<DelegationDetails>, context) =>
      services.run(spawn(args.task, api, context), undefined),
  });
};
