import {
  defineTool,
  type ExtensionFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@usine/core";
import { Effect, Fiber, Stream } from "effect";
import { Type } from "typebox";
import { assembleChildPrompt } from "../prompt.ts";
import {
  type AgentSessionError,
  type ChildBackend,
  ChildRequest,
  ChildSessionBudgetExceededError,
  type WorkingDirectory,
} from "../runtime.ts";

export interface SubagentsExtensionOptions {
  readonly agent: Agent.Agent;
  readonly backend: ChildBackend["Service"];
  readonly cwd: WorkingDirectory;
  readonly emit: (event: Agent.SessionEvent) => Effect.Effect<void>;
  readonly maxChildren: Agent.ChildSessionBudget;
  readonly onBudgetExceeded: (error: ChildSessionBudgetExceededError) => Effect.Effect<void>;
  readonly parentId: Agent.SessionId;
  /**
   * Executes one child program on the parent launch's own services and scope.
   * Pi invokes the tool outside any usine fiber, so running through the
   * default runtime would lose the stderr log redirect (corrupting the
   * protocol stdout) and detach the child from the Attempt's lifetime.
   */
  readonly run: <A>(program: Effect.Effect<A, AgentSessionError>) => Promise<A>;
}

const TASK_EXCERPT_CHARACTERS = 160;

const taskExcerpt = (task: string): string =>
  task.replace(/\s+/gu, " ").trim().slice(0, TASK_EXCERPT_CHARACTERS);

const interrupted = (
  signal: AbortSignal | undefined,
  sessionId: Agent.SessionId,
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

/** Pi-owned extension factory. Its single tool can only create first-level child descriptors. */
export const createSubagentsExtension = (options: SubagentsExtensionOptions): ExtensionFactory => {
  let childNumber = 0;
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
        ],
        parameters: Type.Object(
          { task: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
        executionMode: "parallel",
        execute: (_toolCallId, params, signal, onUpdate) => {
          childNumber += 1;
          const attemptedChildren = Agent.ChildSessionCount.make(childNumber);
          const excerpt = taskExcerpt(params.task);
          const reportsBudget = attemptedChildren === options.maxChildren + 1;
          const program = Effect.scoped(
            Effect.gen(function* () {
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
                if (reportsBudget) yield* options.onBudgetExceeded(error);
                return yield* error;
              }
              const session = new Agent.ChildSession({
                id: Agent.SessionId.make(`${options.parentId}:child:${attemptedChildren}`),
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
                  task: params.task,
                }),
              });
              yield* Effect.annotateCurrentSpan({
                agent: request.session.agent,
                parentSessionId: request.session.parentId,
                sessionId: request.session.id,
              });
              yield* Effect.logInfo("Spawning child session", {
                childrenSpawned: attemptedChildren,
                maxChildren: options.maxChildren,
                taskExcerpt: excerpt,
              });
              const child = yield* options.backend.launch(request);
              const forward = yield* child.events.pipe(
                Stream.runForEach(options.emit),
                Effect.forkScoped,
              );
              const result = yield* Effect.raceFirst(
                child.result,
                interrupted(signal, request.session.id).pipe(
                  Effect.andThen(child.interrupt),
                  Effect.andThen(Effect.interrupt),
                ),
              );
              yield* Fiber.join(forward);
              yield* Effect.logInfo("Child session returned to Pi parent", {
                sessionId: request.session.id,
              });
              onUpdate?.({
                content: [{ type: "text", text: result.message }],
                details: { childSessionId: request.session.id },
              });
              return {
                content: [{ type: "text" as const, text: result.message }],
                details: { childSessionId: request.session.id },
              };
            }),
          ).pipe(Effect.withSpan("Subagents.spawn"));
          return options.run(program);
        },
      }),
    );
  };
};

/** Named wrapper keeps the extension identifiable in Pi startup diagnostics. */
export const subagentsExtension = (options: SubagentsExtensionOptions): InlineExtension => ({
  name: "usine-subagents",
  factory: createSubagentsExtension(options),
});
