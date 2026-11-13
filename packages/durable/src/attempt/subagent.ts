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
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Effect, Match, Option, Schema } from "effect";
import { JournalError } from "./journal-error.ts";
import { durableError } from "../harness.ts";
import { SubagentDoc } from "./child.ts";
import { delegate, type DelegationOutcome } from "./delegation/delegation.ts";
import type {
  DelegationCall,
  DelegationDetails,
  DelegationHub,
  DelegationJournal,
  DelegationStart,
} from "./delegation/journal.ts";
import { type AttemptRecord, AttemptRecordDoc, HoldDoc } from "./documents.ts";
import type { AttemptHub, AttemptHubs } from "./hubs.ts";
import { storedRequestOf } from "./request.ts";
import type { ExtensionServices } from "./services.ts";
import { firstAccepted } from "./watch.ts";

/** The name of the parent's only tool. */
export const SUBAGENT_TOOL = "subagent";

const call =
  (attemptId: AttemptId) =>
  <A>(operation: string, run: (signal: AbortSignal) => PromiseLike<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => JournalError.make({ operation, attemptId, cause }),
    });

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

/**
 * The first blocker, question, or harness failure that a child of the Attempt reported, which fails
 * the Attempt unless the Pi parent relays one.
 */
type ChildBlocker = Omit<StoredBlocker, "kind"> & {
  readonly kind: NonNullable<StoredBlocker["kind"]>;
};

/** A stored blocker without a `kind` predates the other kinds and is a blocker. */
const childBlocker = ({ kind, ...blocker }: StoredBlocker): ChildBlocker => ({
  ...blocker,
  kind: kind ?? "blocked",
});

/**
 * A journal over one `subagent` call. The call's task keys the delegation's `SubagentDoc`. The
 * call counts itself as the Attempt's next delegation and applies the child-session budget, and
 * a new delegation clears the infrastructure failure of a child that no delegation in this
 * process started.
 */
const toolJournal = (
  api: ToolExecutionApi<DelegationDetails>,
  context: ChordContext,
  hub: AttemptHub,
  attemptTaskId: TaskId,
  budget: ChildSessionBudget,
): DelegationJournal => {
  const attemptId = hub.attemptId;
  const run = call(attemptId);
  const commit = <A>(operation: string, change: (tx: Tx) => Promise<A>) =>
    run(operation, () => api.commit(change, context));
  const attempt = (tx: Tx) => tx.doc(AttemptRecordDoc, attemptId, null);
  const delegation = (tx: Tx) => tx.doc(SubagentDoc, api.taskId);
  const hold = (operation: string) =>
    run(operation, () => api.snapshot(HoldDoc, attemptTaskId, context));
  return {
    start: commit("count the child spawn", async (tx) => {
      const record = await attempt(tx);
      const saved = await delegation(tx);
      const progress = {
        output: saved.output,
        saved: Option.map(Option.fromNullOr(saved.saved), (value) => copyJson(value)),
        idle: Option.fromNullishOr(saved.idle),
        idleAnsweredOperator: saved.idleAnsweredOperator ?? false,
        continuations: [...(saved.continuations ?? [])],
        inFlight: (saved.inFlight ?? []).map(({ callId, tool }) => ({ callId, tool })),
        prompted: saved.prompted ?? true,
      };
      if (saved.count !== null)
        return {
          start: {
            _tag: "Admitted",
            count: ChildSessionCount.make(saved.count),
            resumed: true,
            progress,
          } satisfies DelegationStart,
          superseded: Option.none<string>(),
        };
      record.children += 1;
      saved.count = record.children;
      const count = ChildSessionCount.make(record.children);
      if (record.children > budget) {
        record.childBudgetExceeded ??= { attempted: record.children, max: budget };
        return {
          start: { _tag: "Refused", attempted: count, max: budget } satisfies DelegationStart,
          superseded: Option.none<string>(),
        };
      }
      const superseded = Option.filter(
        Option.fromNullOr(record.childBlocker),
        (blocker) =>
          childBlocker(blocker).kind === "infra" && !hub.childSpawns.has(blocker.sessionId),
      );
      if (Option.isSome(superseded)) record.childBlocker = null;
      return {
        start: { _tag: "Admitted", count, resumed: false, progress } satisfies DelegationStart,
        superseded: Option.map(superseded, ({ sessionId }) => sessionId),
      };
    }).pipe(
      Effect.tap(({ superseded }) =>
        Option.match(superseded, {
          onNone: () => Effect.void,
          onSome: (previousChildSessionId) =>
            Effect.logInfo(
              "New delegation supersedes the previous child's infrastructure failure",
              {
                attemptId,
                previousChildSessionId,
              },
            ),
        }),
      ),
      Effect.map(({ start }) => start),
    ),
    queuedInputs: (sessionId) =>
      run("restore the child's operator inputs", () =>
        api.snapshot(AttemptRecordDoc, attemptId, context),
      ).pipe(
        // The Pi path stores the intervention's encoded form (`attempt/runtime.ts`).
        Effect.flatMap((record) =>
          Effect.forEach(
            (record?.queuedInputs ?? []).filter(
              (input) => "child" in input && input.child === sessionId,
            ),
            (input) =>
              Schema.decodeEffect(AttemptChannel.Intervention)(input.intervention).pipe(
                Effect.map((intervention) => ({
                  inputSequence: AttemptChannel.Sequence.make(input.inputSequence),
                  intervention,
                })),
              ),
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
      run("wait for the child's Hold to end", async (signal) => {
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
    saveIdle: (report, answeredOperator) =>
      commit("save the child's idle report", async (tx) => {
        const record = await delegation(tx);
        record.idle = Option.getOrNull(report);
        record.idleAnsweredOperator = answeredOperator;
      }),
    saveOutput: (output) =>
      commit("save the child's partial output", async (tx) => {
        const record = await delegation(tx);
        record.output = output;
      }),
  };
};

/**
 * One `subagent` call: its running output and details are the delegation's, and its abort ends
 * the delegation. A child's reserved report or infrastructure failure becomes the Attempt's child
 * blocker, which fails the Attempt unless the parent relays a reserved report itself. The first
 * reserved report wins, and an infrastructure failure replaces a report but not another failure.
 */
const toolCall = (
  api: ToolExecutionApi<DelegationDetails>,
  context: ChordContext,
  attemptId: AttemptId,
): DelegationCall => {
  const run = call(attemptId);
  const commit = <A>(operation: string, change: (tx: Tx) => Promise<A>) =>
    run(operation, () => api.commit(change, context));
  const recordBlocker = (blocker: ChildBlocker, keeps: (current: ChildBlocker) => boolean) =>
    commit(
      blocker.kind === "infra"
        ? "record the child's infrastructure failure"
        : "record the child's report",
      async (tx) => {
        const record = await tx.doc(AttemptRecordDoc, attemptId, null);
        if (record.childBlocker !== null && keeps(childBlocker(record.childBlocker))) return false;
        record.childBlocker = { ...blocker };
        return true;
      },
    );
  return {
    output: (chunk) =>
      Effect.try({
        try: () => api.output(chunk),
        catch: (cause) =>
          JournalError.make({ operation: "record the child's output", attemptId, cause }),
      }),
    retainedOutput: Effect.sync(() => api.retainedOutput().text),
    publish: (details) =>
      run(
        details.saved === undefined
          ? "publish the child's id"
          : "publish the saved child conversation",
        () => api.details(details, context),
      ),
    aborted: aborted(context),
    infrastructureFailed: (sessionId, message) =>
      recordBlocker(
        { sessionId, message, kind: "infra" },
        (current) => current.kind === "infra",
      ).pipe(
        Effect.flatMap((recorded) =>
          recorded
            ? Effect.void
            : Effect.logInfo(
                "Kept the Attempt's first child infrastructure failure ahead of this one",
                { attemptId, sessionId },
              ),
        ),
      ),
    reserved: (sessionId, { kind, message, resetsAt }) =>
      recordBlocker(
        {
          sessionId,
          message,
          kind,
          ...Option.match(resetsAt, {
            onNone: () => ({}),
            onSome: (value) => ({ resetsAt: value }),
          }),
        },
        () => true,
      ).pipe(
        Effect.flatMap((first) =>
          first
            ? Effect.void
            : Effect.logInfo("Kept the Attempt's first child report ahead of this one", {
                sessionId,
              }),
        ),
      ),
    recovered: (sessionId) =>
      commit("clear the recovered child's infrastructure failure", async (tx) => {
        const record = await tx.doc(AttemptRecordDoc, attemptId, null);
        if (record.childBlocker === null) return false;
        const current = childBlocker(record.childBlocker);
        if (current.kind !== "infra" || current.sessionId !== sessionId) return false;
        record.childBlocker = null;
        return true;
      }).pipe(
        Effect.flatMap((cleared) =>
          cleared
            ? Effect.logInfo("Recovered child's report replaces its infrastructure failure", {
                attemptId,
                sessionId,
              })
            : Effect.void,
        ),
      ),
  };
};

/** The view of an Attempt's hub that its delegations use. */
const delegationHub = (hubs: AttemptHubs, hub: AttemptHub): DelegationHub => ({
  children: hub.children,
  childSpawns: hub.childSpawns,
  childInputs: hub.childInputs,
  routing: hub.routing,
  get attached() {
    return hub.attached;
  },
  event: (event) => hubs.event(hub, event),
  delivery: (delivery) => hubs.delivery(hub, delivery),
});

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
    const owner = yield* Effect.tryPromise({
      try: () =>
        api.commit(async (tx) => {
          const conversation = await tx.conversation(api.conversationId);
          if (conversation?.owner === undefined) return undefined;
          const record = await tx.task(conversation.owner.taskId);
          return record === undefined ? undefined : { taskId: record.id, input: record.input };
        }, context),
      catch: (cause) => durableError("find the parent's Attempt task", cause),
    });
    if (owner === undefined) {
      return yield* Effect.die(
        new Error("The subagent tool runs only in an attempt's parent conversation"),
      );
    }
    const { spec } = yield* storedRequestOf(owner.input);
    const hub = yield* services.hubs.hub(spec.attemptId, owner.taskId);
    services.hubs.bindParent(hub, api.conversationId);
    const outcome = yield* delegate(services.backend, {
      spec,
      hub: delegationHub(services.hubs, hub),
      journal: toolJournal(
        api,
        context,
        hub,
        owner.taskId,
        ChildSessionBudget.make(spec.maxChildren),
      ),
      call: toolCall(api, context, spec.attemptId),
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
