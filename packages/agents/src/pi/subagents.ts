import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  defineTool,
  type ExtensionFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@usine/core/agent";
import {
  AgentSessionEvent,
  AgentSessionId,
  ChildSession,
  ChildSessionBudget,
  ChildSessionCount,
  SessionFinished,
} from "@usine/core/agent/session";
import { Effect, Exit, Fiber, Stream } from "effect";
import { Type } from "typebox";
import { assembleChildPrompt } from "../prompt.ts";
import {
  type AgentSessionError,
  BLOCKED_MARKER,
  type ChildBackend,
  ChildRequest,
  ChildSessionBudgetExceededError,
  type ChildSessions,
  SessionResult,
  type WorkingDirectory,
} from "../runtime.ts";

export interface SubagentsExtensionOptions {
  readonly agent: Agent;
  readonly backend: ChildBackend["Service"];
  /** Records each child's returned report on the parent, so a blocker the parent paraphrases still fails the Attempt. */
  readonly childReturned: (session: ChildSession, result: SessionResult) => Effect.Effect<void>;
  readonly cwd: WorkingDirectory;
  readonly emit: (event: AgentSessionEvent) => Effect.Effect<void>;
  readonly maxChildren: ChildSessionBudget;
  /** Called on every rejected spawn; the parent decides what a repeat means. */
  readonly onBudgetExceeded: (error: ChildSessionBudgetExceededError) => Effect.Effect<void>;
  readonly parentId: AgentSessionId;
  /** Records a launched child so the run host can address operator input to it by id. */
  readonly register: ChildSessions["register"];
  /**
   * Runs one child program on the parent launch's services and scope. Pi
   * calls the tool outside any usine fiber, so the default runtime would lose
   * the stderr log redirect (corrupting the protocol stdout) and detach the
   * child from the Attempt's lifetime.
   */
  readonly run: <A>(program: Effect.Effect<A, AgentSessionError>) => Promise<A>;
}

const TASK_EXCERPT_CHARACTERS = 160;

const taskExcerpt = (task: string): string => {
  const collapsed = task.replace(/\s+/gu, " ").trim();
  return collapsed.length > TASK_EXCERPT_CHARACTERS
    ? `${collapsed.slice(0, TASK_EXCERPT_CHARACTERS)}…`
    : collapsed;
};

const interrupted = (
  signal: AbortSignal | undefined,
  sessionId: AgentSessionId,
): Effect.Effect<void> =>
  signal === undefined
    ? Effect.logWarning("Pi supplied no abort signal; the child outlives only its scope", {
        sessionId,
      }).pipe(Effect.andThen(Effect.never))
    : Effect.callback<void>((resume) => {
        const onAbort = () => resume(Effect.void);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
      });

interface SpawnDetails {
  readonly childSessionId: AgentSessionId;
}

/** Builds the subagents extension; its single tool creates first-level child sessions only. */
export const createSubagentsExtension = (options: SubagentsExtensionOptions): ExtensionFactory => {
  let childNumber = 0;
  const spawn = Effect.fn("Subagents.spawn")(function* (
    attemptedChildren: ChildSessionCount,
    task: string,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SpawnDetails> | undefined,
  ) {
    const excerpt = taskExcerpt(task);
    yield* Effect.annotateCurrentSpan({
      attemptedChildren,
      maxChildren: options.maxChildren,
      parentSessionId: options.parentId,
    });
    if (attemptedChildren > options.maxChildren) {
      const error = new ChildSessionBudgetExceededError({
        attemptedChildren,
        maxChildren: options.maxChildren,
        message: `Attempt tried to spawn child ${attemptedChildren} after reaching its ${options.maxChildren}-child budget`,
      });
      yield* Effect.logWarning("Child session budget exceeded", {
        attemptedChildren,
        maxChildren: options.maxChildren,
        parentSessionId: options.parentId,
        taskExcerpt: excerpt,
      });
      yield* options.onBudgetExceeded(error);
      return yield* error;
    }
    const session = new ChildSession({
      id: AgentSessionId.make(`${options.parentId}:child:${attemptedChildren}`),
      parentId: options.parentId,
      agent: options.agent.name,
      brain: options.agent.brain,
    });
    const request = new ChildRequest({
      session,
      cwd: options.cwd,
      prompt: assembleChildPrompt({
        agent: options.agent.name,
        persona: options.agent.persona,
        task,
      }),
    });
    yield* Effect.annotateCurrentSpan({
      agent: request.session.agent,
      sessionId: request.session.id,
    });
    yield* Effect.logInfo("Spawning child session", {
      attemptedChildren,
      maxChildren: options.maxChildren,
      taskExcerpt: excerpt,
    });
    const child = yield* options.backend.launch(request);
    // Registered on the spawn scope, so the child stops being addressable when it returns.
    yield* options.register(child);
    yield* Effect.addFinalizer((exit) =>
      Exit.isFailure(exit)
        ? Effect.logWarning("Child session ended before returning a result", {
            sessionId: session.id,
          }).pipe(Effect.andThen(options.emit(new SessionFinished({ session: child.session }))))
        : Effect.void,
    );
    // A child's failed report ends its event stream with the same error its
    // result carries; the report below returns that error to the parent.
    const forward = yield* child.events.pipe(
      Stream.runForEach(options.emit),
      Effect.catchTag("AgentResultError", () => Effect.void),
      Effect.forkScoped,
    );
    const result = yield* Effect.raceFirst(
      child.result.pipe(
        Effect.catchTag("AgentResultError", (error) =>
          Effect.logInfo("Child session reported a blocker to Pi parent", {
            sessionId: request.session.id,
          }).pipe(
            Effect.andThen(Fiber.join(forward)),
            Effect.andThen(options.emit(new SessionFinished({ session: child.session }))),
            Effect.as(new SessionResult({ message: `${BLOCKED_MARKER}\n${error.message}` })),
          ),
        ),
      ),
      interrupted(signal, request.session.id).pipe(
        Effect.andThen(child.interrupt),
        Effect.andThen(Effect.interrupt),
      ),
    );
    yield* Fiber.join(forward);
    yield* options.childReturned(session, result);
    yield* Effect.logInfo("Child session returned to Pi parent", {
      sessionId: request.session.id,
    });
    const report: AgentToolResult<SpawnDetails> = {
      content: [{ type: "text", text: result.message }],
      details: { childSessionId: request.session.id },
    };
    onUpdate?.(report);
    return report;
  }, Effect.scoped);
  return (pi) => {
    pi.registerTool(
      defineTool({
        name: "subagent",
        label: "Subagent",
        description:
          "Delegate one focused task to the configured isolated child agent and wait for its report.",
        promptSnippet: "Delegate a focused task to an isolated child agent.",
        promptGuidelines: [
          "Delegate only independent, focused work; the child cannot create more children.",
          `When a child's report starts with ${BLOCKED_MARKER}, return that report verbatim as your own final answer instead of summarising it.`,
        ],
        parameters: Type.Object(
          { task: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
        executionMode: "parallel",
        execute: (_toolCallId, params, signal, onUpdate) => {
          childNumber += 1;
          return options.run(
            spawn(ChildSessionCount.make(childNumber), params.task, signal, onUpdate),
          );
        },
      }),
    );
  };
};

/** Names the extension so Pi startup diagnostics can identify it. */
export const subagentsExtension = (options: SubagentsExtensionOptions): InlineExtension => ({
  name: "usine-subagents",
  factory: createSubagentsExtension(options),
});
