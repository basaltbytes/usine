import type { Context as ChordContext } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { assembleChildPrompt } from "@usine/agents/prompt";
import {
  ChildRequest,
  ChildSessionBudgetExceededError,
  reportText,
  type RunningSession,
  WorkingDirectory,
} from "@usine/agents/runtime";
import {
  type AgentSessionEvent,
  AgentSessionId,
  ChildSession,
  ChildSessionBudget,
  ChildSessionCount,
  SessionFinished,
} from "@usine/core/agent/session";
import { Deferred, Effect, Exit, Fiber, Match, Option, Result, Stream } from "effect";
import { durableError } from "../harness.ts";
import { AttemptRecordDoc, HoldDoc } from "./documents.ts";
import type { AttemptHub } from "./hubs.ts";
import { parentSessionId } from "./parent.ts";
import { storedRequestOf } from "./request.ts";
import type { ExtensionServices } from "./services.ts";
import { firstAccepted } from "./watch.ts";

/** The parent's only tool. */
export const SUBAGENT_TOOL = "subagent";

type SpawnDetails = { childSessionId: string };

const TASK_EXCERPT_CHARACTERS = 160;

const taskExcerpt = (task: string): string => {
  const collapsed = task.replace(/\s+/gu, " ").trim();
  return collapsed.length > TASK_EXCERPT_CHARACTERS
    ? `${collapsed.slice(0, TASK_EXCERPT_CHARACTERS)}…`
    : collapsed;
};

const call = <A>(operation: string, run: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => durableError(operation, cause) });

const aborted = (context: ChordContext, sessionId: AgentSessionId): Effect.Effect<void> =>
  Option.match(Option.fromNullishOr(context.abortSignal), {
    onNone: () =>
      Effect.logWarning("pi-durable supplied no abort signal; the child outlives only its scope", {
        sessionId,
      }).pipe(Effect.andThen(Effect.never)),
    onSome: (signal) =>
      Effect.callback<void>((resume) => {
        const onAbort = () => resume(Effect.void);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
      }),
  });

/** Keeps the child addressable by id for operator input while its scope is open. */
const register = (hub: AttemptHub, child: RunningSession) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      hub.children.set(child.session.id, child);
    }),
    () => Effect.sync(() => hub.children.delete(child.session.id)),
  );

/**
 * Builds the `subagent` tool: one call delegates one focused task to a child
 * of the Agent's harness, in the Attempt's checkout, and returns its report. A
 * child is not replay-safe: after a restart the call settles as interrupted
 * with the output committed so far, and the parent may spawn a new child.
 */
export const subagentTool = (services: ExtensionServices) => {
  const spawn = Effect.fn("Subagent.spawn")(function* (
    task: string,
    api: ToolExecutionApi<SpawnDetails>,
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
        new Error("The subagent tool runs only in an Attempt's parent conversation"),
      );
    }
    const stored = yield* storedRequestOf(owner.input);
    const spec = stored.spec;
    const parentId = parentSessionId(spec.attemptId);
    const hub = yield* services.hubs.hub(spec.attemptId, owner.taskId);
    services.hubs.bindParent(hub, api.conversationId);
    const excerpt = taskExcerpt(task);
    const attemptedChildren = ChildSessionCount.make(
      yield* call("count the child spawn", () =>
        api.commit(async (tx) => {
          const record = await tx.doc(AttemptRecordDoc, spec.attemptId, null);
          record.children += 1;
          if (record.children > spec.maxChildren && record.childBudgetExceeded === null) {
            record.childBudgetExceeded = { attempted: record.children, max: spec.maxChildren };
          }
          return record.children;
        }, context),
      ),
    );
    yield* Effect.annotateCurrentSpan({
      attemptId: spec.attemptId,
      attemptedChildren,
      maxChildren: spec.maxChildren,
      parentSessionId: parentId,
    });
    if (attemptedChildren > spec.maxChildren) {
      yield* Effect.logWarning("Child session budget exceeded", {
        attemptedChildren,
        maxChildren: spec.maxChildren,
        parentSessionId: parentId,
        taskExcerpt: excerpt,
      });
      return yield* new ChildSessionBudgetExceededError({
        attemptedChildren,
        maxChildren: ChildSessionBudget.make(spec.maxChildren),
        message: `Attempt tried to spawn child ${attemptedChildren} after reaching its ${spec.maxChildren}-child budget`,
      });
    }
    if (!(yield* Deferred.isDone(hub.attached))) {
      yield* Effect.logInfo(
        "Waiting for execute to supply the Attempt's child host and environment before spawning a child",
        {
          attemptId: spec.attemptId,
        },
      );
    }
    const request = yield* Deferred.await(hub.attached);
    const session = new ChildSession({
      id: AgentSessionId.make(`${parentId}:child:${attemptedChildren}`),
      parentId,
      agent: spec.agent.name,
      brain: spec.agent.brain,
    });
    const childRequest = new ChildRequest({
      session,
      cwd: WorkingDirectory.make(request.cwd),
      environment: request.environment,
      host: request.host,
      prompt: assembleChildPrompt({
        agent: spec.agent.name,
        persona: spec.agent.persona,
        task,
      }),
    });
    yield* Effect.annotateCurrentSpan({ agent: session.agent, sessionId: session.id });
    yield* Effect.logInfo("Spawning child session", {
      attemptedChildren,
      maxChildren: spec.maxChildren,
      sessionId: session.id,
      taskExcerpt: excerpt,
    });
    const child = yield* services.backend.launch(childRequest);
    yield* register(hub, child);
    yield* Effect.addFinalizer((exit) =>
      Exit.isFailure(exit)
        ? Effect.logWarning("Child session ended before returning a result", {
            sessionId: session.id,
          }).pipe(
            Effect.andThen(
              services.hubs.event(hub, new SessionFinished({ session: child.session })),
            ),
          )
        : Effect.void,
    );
    yield* call("publish the child's id", () =>
      api.details({ childSessionId: session.id }, context),
    );
    const forward = (event: AgentSessionEvent) =>
      services.hubs.event(hub, event).pipe(
        Effect.andThen(
          event._tag === "TextOutput"
            ? Effect.try({
                try: () => api.output(`${event.text}\n`),
                catch: (cause) => durableError("record the child's output", cause),
              }).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Could not record the child's output on the tool call", {
                    sessionId: session.id,
                    message: error.message,
                  }),
                ),
                Effect.ignore,
              )
            : Effect.void,
        ),
      );
    // The child's result carries the same report that ends its stream.
    const forwarding = yield* child.events.pipe(
      Stream.runForEach(forward),
      Effect.catchTag(
        ["AgentResultError", "AgentBlockedError", "AgentQuestionError"],
        () => Effect.void,
      ),
      Effect.forkScoped,
    );
    const outcome = yield* Effect.raceFirst(
      child.result.pipe(
        Effect.map(Result.succeed),
        Effect.catchTag(["AgentResultError", "AgentBlockedError", "AgentQuestionError"], (report) =>
          Effect.succeed(Result.fail(report)),
        ),
      ),
      aborted(context, session.id).pipe(
        Effect.tap(() =>
          Effect.logInfo("Interrupting the child of an aborted tool call", {
            sessionId: session.id,
          }),
        ),
        Effect.andThen(child.interrupt),
        Effect.andThen(Effect.interrupt),
      ),
    );
    yield* Fiber.join(forwarding);
    yield* call("wait for the child's Hold to end", async (signal) => {
      const scoped = withAbortSignal(signal, context);
      const watch = await api.watchDoc(HoldDoc, owner.taskId, scoped);
      if (watch === undefined) return;
      await firstAccepted(watch, (hold) => !hold.held.includes(session.id), scoped);
    });
    const text = yield* Result.match(outcome, {
      onFailure: (report) =>
        Effect.gen(function* () {
          const kind = Match.valueTags(report, {
            AgentResultError: () => "failed" as const,
            AgentBlockedError: () => "blocked" as const,
            AgentQuestionError: () => "question" as const,
          });
          yield* Effect.logInfo("Child session returned a reserved report to the Pi parent", {
            sessionId: session.id,
            kind,
          });
          const first = yield* call("record the child's report", () =>
            api.commit(async (tx) => {
              const record = await tx.doc(AttemptRecordDoc, spec.attemptId, null);
              if (record.childBlocker !== null) return false;
              record.childBlocker = { sessionId: session.id, message: report.message, kind };
              return true;
            }, context),
          );
          if (!first) {
            yield* Effect.logInfo("Kept the Attempt's first child report ahead of this one", {
              sessionId: session.id,
            });
          }
          yield* services.hubs.event(hub, new SessionFinished({ session: child.session }));
          return reportText(report);
        }),
      onSuccess: (result) =>
        Effect.logInfo("Child session returned to the Pi parent", { sessionId: session.id }).pipe(
          Effect.as(result.message),
        ),
    });
    return {
      content: [{ type: "text" as const, text }],
      details: { childSessionId: session.id },
    };
  }, Effect.scoped);

  return defineTool({
    name: SUBAGENT_TOOL,
    description:
      "Delegate one focused task to the configured isolated child agent and wait for its report.",
    parameters: Type.Object(
      { task: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    replay: "unsafe",
    execute: (args, api: ToolExecutionApi<SpawnDetails>, context) =>
      services.run(spawn(args.task, api, context), undefined),
  });
};
