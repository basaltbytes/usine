// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { copyJson, type Context as ChordContext } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { assembleChildPrompt } from "@usine/agents/prompt";
import {
  AgentSessionError,
  ChildRequest,
  ChildSessionLifecycle,
  ChildSessionBudgetExceededError,
  SessionOperationError,
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
  SessionStarted,
} from "@usine/core/agent/session";
import { Deferred, Effect, Exit, Fiber, Match, Option, Result, Schema, Stream } from "effect";
import { durableError, type DurableHarnessError } from "../harness.ts";
import { AttemptRecordDoc, HoldDoc } from "./documents.ts";
import type { AttemptHub } from "./hubs.ts";
import { parentSessionId } from "./parent.ts";
import { storedRequestOf } from "./request.ts";
import type { ExtensionServices } from "./services.ts";
import { SavedChild, SubagentDoc } from "./child.ts";
import { firstAccepted } from "./watch.ts";

/** The name of the parent's only tool. */
export const SUBAGENT_TOOL = "subagent";

type SpawnDetails = {
  childSessionId: string;
  saved?: typeof SavedChild.Encoded;
};

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

/** Runs `effect` until the tool call aborts. On abort, runs `onAbort` and interrupts the call. */
const untilAborted = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  context: ChordContext,
  sessionId: AgentSessionId,
  onAbort: Effect.Effect<void, E>,
) =>
  Effect.raceFirst(
    effect,
    aborted(context, sessionId).pipe(Effect.andThen(onAbort), Effect.andThen(Effect.interrupt)),
  );

/** Registers the child in `hub.children` until the scope closes. */
const register = (hub: AttemptHub, child: RunningSession) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      hub.children.set(child.session.id, child);
    }),
    () => Effect.sync(() => hub.children.delete(child.session.id)),
  );

/**
 * Builds the `subagent` tool, which runs one task in a child of the Agent's harness and returns the
 * child's report. A replay continues the saved child conversation in the retained checkout.
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
        new Error("The subagent tool runs only in an attempt's parent conversation"),
      );
    }
    const stored = yield* storedRequestOf(owner.input);
    const spec = stored.spec;
    const parentId = parentSessionId(spec.attemptId);
    const hub = yield* services.hubs.hub(spec.attemptId, owner.taskId);
    services.hubs.bindParent(hub, api.conversationId);
    const excerpt = taskExcerpt(task);
    const { childCount, supersededChild, replayed, previous } = yield* call(
      "count the child spawn",
      () =>
        api.commit(async (tx) => {
          const record = await tx.doc(AttemptRecordDoc, spec.attemptId, null);
          const delegation = await tx.doc(SubagentDoc, api.taskId);
          const previous = {
            output: delegation.output,
            saved: copyJson(delegation.saved),
            idle: delegation.idle,
          };
          if (delegation.count !== null)
            return {
              childCount: delegation.count,
              supersededChild: null,
              replayed: true,
              previous,
            };
          record.children += 1;
          delegation.count = record.children;
          if (record.children > spec.maxChildren) {
            record.childBudgetExceeded ??= { attempted: record.children, max: spec.maxChildren };
            return {
              childCount: record.children,
              supersededChild: null,
              replayed: false,
              previous,
            };
          }
          const supersededChild =
            record.childBlocker?.kind === "infra" &&
            !hub.childSpawns.has(record.childBlocker.sessionId)
              ? record.childBlocker.sessionId
              : null;
          if (supersededChild !== null) record.childBlocker = null;
          return {
            childCount: record.children,
            supersededChild,
            replayed: false,
            previous,
          };
        }, context),
    );
    const attemptedChildren = ChildSessionCount.make(childCount);
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
      return yield* ChildSessionBudgetExceededError.make({
        attemptedChildren,
        maxChildren: ChildSessionBudget.make(spec.maxChildren),
        message: `Attempt tried to spawn child ${attemptedChildren} after reaching its ${spec.maxChildren}-child budget`,
      });
    }
    const sessionId = AgentSessionId.make(`${parentId}:child:${attemptedChildren}`);
    const checkpoint = <A>(effect: Effect.Effect<A, DurableHarnessError>) =>
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
        hub.childSpawns.delete(sessionId);
        yield* call("clear the interrupted child's supervision", () =>
          api.commit(async (tx) => {
            const hold = await tx.doc(HoldDoc, owner.taskId);
            hold.held = hold.held.filter((id) => id !== sessionId);
            hold.pausedChildren = (hold.pausedChildren ?? []).filter((id) => id !== sessionId);
          }, context),
        );
        yield* services.hubs.event(
          hub,
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
      }).pipe(
        Effect.as({
          output: [{ type: "text" as const, text: api.retainedOutput().text || previous.output }],
          isError: true,
          diagnostics: [
            {
              severity: "error" as const,
              code: "interrupted",
              message: `Tool subagent was interrupted: ${reason}`,
            },
          ],
          details: { childSessionId: sessionId },
        } satisfies ToolExecutionResult<SpawnDetails>),
      );
    if (replayed)
      yield* checkpoint(
        Effect.try({
          try: () => api.output(previous.output),
          catch: (cause) => durableError("restore the child's output", cause),
        }),
      );
    const decoded = yield* Option.match(Option.fromNullOr(previous.saved), {
      onNone: () => Effect.succeedNone,
      onSome: (value) => Schema.decodeUnknownEffect(SavedChild)(value).pipe(Effect.asSome),
    }).pipe(Effect.result);
    if (Result.isFailure(decoded))
      return yield* interrupted("the saved conversation no longer decodes");
    const saved = decoded.success;
    if (replayed && Option.isNone(saved))
      return yield* interrupted("the child did not commit a saved conversation");
    hub.childSpawns.add(sessionId);
    if (supersededChild !== null) {
      yield* Effect.logInfo(
        "New delegation supersedes the previous child's infrastructure failure",
        {
          attemptId: spec.attemptId,
          sessionId,
          previousChildSessionId: supersededChild,
        },
      );
    }
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
      context,
      sessionId,
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
    const { held, paused } = yield* call("restore the child's supervision", async () => {
      const hold = await api.snapshot(HoldDoc, owner.taskId, context);
      return {
        held: hold?.held.includes(sessionId) ?? false,
        paused: hold?.pausedChildren?.includes(sessionId) ?? false,
      };
    });
    const idle = Option.fromNullishOr(previous.idle);
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
      prompt: assembleChildPrompt({
        baseCommit: spec.baseCommit,
        agent: spec.agent.name,
        persona: spec.agent.persona,
        task: spec.task,
        context: replayed
          ? `${task}\n\nThe orchestrator restarted. Continue this saved conversation in the same checkout. Check the results of any interrupted commands before repeating work, then return the final report.`
          : task,
      }),
    });
    yield* Effect.annotateCurrentSpan({ agent: session.agent, sessionId: session.id });
    yield* Effect.logInfo(
      "Spawning child session with the rendered task and supplemental parent context",
      {
        attemptedChildren,
        maxChildren: spec.maxChildren,
        sessionId: session.id,
        taskCharacters: spec.task.length,
        contextCharacters: task.length,
        taskExcerpt: excerpt,
      },
    );
    const recordInfrastructureFailure = (error: AgentSessionError) =>
      !replayed && error._tag === "SessionOperationError"
        ? call("record the child's infrastructure failure", () =>
            api.commit(async (tx) => {
              const record = await tx.doc(AttemptRecordDoc, spec.attemptId, null);
              if (record.childBlocker?.kind !== "infra")
                record.childBlocker = { sessionId, message: error.message, kind: "infra" };
            }, context),
          ).pipe(
            Effect.mapError((cause) =>
              SessionOperationError.make({
                operation: "stream",
                sessionId: Option.some(sessionId),
                message: cause.message,
                cause,
              }),
            ),
            Effect.andThen(
              Effect.logWarning("Child infrastructure failure requires an automatic retry", {
                attemptId: spec.attemptId,
                sessionId,
                message: error.message,
              }),
            ),
          )
        : Effect.void;
    const runChild = Effect.gen(function* () {
      // Annotate logs with the Attempt because this tool runs outside the Attempt's fiber. An abort
      // interrupts a launch that is still waiting through retry delays.
      const child = yield* untilAborted(
        services.backend
          .launch(childRequest)
          .pipe(
            Effect.provideService(ChildSessionLifecycle, lifecycle),
            Effect.tapError(recordInfrastructureFailure),
            Effect.annotateLogs({ attemptId: spec.attemptId, worker: request.worker }),
          ),
        context,
        session.id,
        Effect.logInfo("Abandoning the child launch of an aborted tool call", {
          sessionId: session.id,
        }),
      );
      yield* register(hub, child);
      yield* Effect.addFinalizer((exit) =>
        Exit.isFailure(exit)
          ? Effect.logWarning("Child session ended before returning a result", {
              sessionId: session.id,
            }).pipe(
              Effect.andThen(
                services.hubs.event(hub, SessionFinished.make({ session: child.session })),
              ),
            )
          : Effect.void,
      );
      yield* call("publish the child's id", () =>
        api.details({ childSessionId: session.id }, context),
      );
      let cumulativeUsage = childRequest.usage;
      const forward = (event: AgentSessionEvent) =>
        Effect.gen(function* () {
          if (
            event._tag === "SessionIdle" ||
            event._tag === "SessionResumed" ||
            event._tag === "SessionFinished"
          )
            yield* checkpoint(
              call("save the child's idle report", () =>
                api.commit(async (tx) => {
                  const record = await tx.doc(SubagentDoc, api.taskId);
                  record.idle =
                    event._tag === "SessionIdle" ? Option.getOrNull(event.message) : null;
                }, context),
              ),
            );
          if (
            event._tag === "SessionStarted" &&
            event.session._tag === "ChildSession" &&
            Option.isSome(event.harnessSession)
          ) {
            const recovery = yield* Schema.encodeEffect(SavedChild)(
              SavedChild.make({
                session: event.session,
                usage: cumulativeUsage,
                harnessSession: event.harnessSession.value,
                worker: request.worker,
                machine: request.machine,
              }),
            ).pipe(Effect.orDie);
            yield* checkpoint(
              call("save the child's conversation", () =>
                api.commit(async (tx) => {
                  const record = await tx.doc(SubagentDoc, api.taskId);
                  record.saved = recovery;
                }, context),
              ),
            );
            yield* checkpoint(
              call("publish the saved child conversation", () =>
                api.details({ childSessionId: session.id, saved: recovery }, context),
              ),
            );
          }
          if (event._tag === "SessionTokensUpdated") {
            cumulativeUsage = Option.some(event);
            const usage = yield* Schema.encodeEffect(ChildRequest.fields.usage)(
              cumulativeUsage,
            ).pipe(Effect.orDie);
            yield* checkpoint(
              call("save the child's cumulative usage", () =>
                api.commit(async (tx) => {
                  const record = await tx.doc(SubagentDoc, api.taskId);
                  if (record.saved !== null) record.saved.usage = usage;
                }, context),
              ),
            );
          }
          if (event._tag === "TextOutput") {
            yield* checkpoint(
              Effect.try({
                try: () => api.output(`${event.text}\n`),
                catch: (cause) => durableError("record the child's output", cause),
              }),
            );
            const output = api.retainedOutput().text;
            yield* checkpoint(
              call("save the child's partial output", () =>
                api.commit(async (tx) => {
                  const record = await tx.doc(SubagentDoc, api.taskId);
                  record.output = output;
                }, context),
              ),
            );
          }
          const recorded =
            event._tag === "SessionStarted"
              ? SessionStarted.make({ ...event, prompt: Option.some(childRequest.prompt) })
              : event;
          yield* services.hubs.event(hub, recorded);
        });
      // These errors end the stream with the same report the child's result contains, so they are
      // ignored here.
      const forwarding = yield* child.events.pipe(
        Stream.runForEach(forward),
        Effect.catchTag(
          ["AgentResultError", "AgentCapacityError", "AgentBlockedError", "AgentQuestionError"],
          () => Effect.void,
        ),
        Effect.forkScoped,
      );
      const outcome = yield* untilAborted(
        child.result.pipe(
          Effect.tapError(recordInfrastructureFailure),
          Effect.map(Result.succeed),
          Effect.catchTag(
            ["AgentResultError", "AgentCapacityError", "AgentBlockedError", "AgentQuestionError"],
            (report) => Effect.succeed(Result.fail(report)),
          ),
        ),
        context,
        session.id,
        Effect.logInfo("Interrupting the child of an aborted tool call", {
          sessionId: session.id,
        }).pipe(Effect.andThen(child.interrupt)),
      );
      yield* Fiber.join(forwarding);
      yield* call("wait for the child's Hold to end", async (signal) => {
        const scoped = withAbortSignal(signal, context);
        const watch = await api.watchDoc(HoldDoc, owner.taskId, scoped);
        if (watch === undefined) return;
        await firstAccepted(watch, (hold) => !hold.held.includes(session.id), scoped);
      });
      if (replayed) {
        const cleared = yield* call("clear the recovered child's infrastructure failure", () =>
          api.commit(async (tx) => {
            const record = await tx.doc(AttemptRecordDoc, spec.attemptId, null);
            if (
              record.childBlocker?.kind !== "infra" ||
              record.childBlocker.sessionId !== session.id
            )
              return false;
            record.childBlocker = null;
            return true;
          }, context),
        );
        if (cleared)
          yield* Effect.logInfo("Recovered child's report replaces its infrastructure failure", {
            attemptId: spec.attemptId,
            sessionId: session.id,
          });
      }
      const text = yield* Result.match(outcome, {
        onFailure: (report) =>
          Effect.gen(function* () {
            const kind = Match.valueTags(report, {
              AgentResultError: () => "failed" as const,
              AgentCapacityError: () => "capacity" as const,
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
            yield* services.hubs.event(hub, SessionFinished.make({ session: child.session }));
            return reportText(report);
          }),
        onSuccess: (result) =>
          Effect.logInfo("Child session returned to the Pi parent", { sessionId: session.id }).pipe(
            Effect.as(result.message),
          ),
      });
      return {
        output: [{ type: "text" as const, text }],
      } satisfies ToolExecutionResult<SpawnDetails>;
    }).pipe(Effect.scoped);
    return yield* replayed
      ? runChild.pipe(
          Effect.catchIf(Schema.is(AgentSessionError), (error) => interrupted(error.message)),
        )
      : runChild;
  }, Effect.scoped);

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
    execute: (args, api: ToolExecutionApi<SpawnDetails>, context) =>
      services.run(spawn(args.task, api, context), undefined),
  });
};
