import {
  defineTool,
  type ExtensionFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@usine/core";
import { Effect, Fiber, Stream } from "effect";
import { Type } from "typebox";
import { assembleChildPrompt } from "../prompt.ts";
import { type ChildBackend, ChildRequest, type WorkingDirectory } from "../runtime.ts";

export interface SubagentsExtensionOptions {
  readonly agent: Agent.Agent;
  readonly backend: ChildBackend["Service"];
  readonly cwd: WorkingDirectory;
  readonly emit: (activity: Agent.Activity) => Effect.Effect<void>;
  readonly parentId: Agent.SessionId;
}

const interrupted = (signal: AbortSignal | undefined): Effect.Effect<void> =>
  signal === undefined
    ? Effect.never
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
          const session = new Agent.ChildSession({
            id: Agent.SessionId.make(`${options.parentId}:child:${childNumber}`),
            parentId: options.parentId,
            agent: options.agent.name,
            brain: Agent.brainOf(options.agent),
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
          const program = Effect.scoped(
            Effect.gen(function* () {
              const child = yield* options.backend.launch(request);
              const forward = yield* child.events.pipe(
                Stream.runForEach(options.emit),
                Effect.forkScoped,
              );
              const result = yield* Effect.raceFirst(
                child.result,
                interrupted(signal).pipe(
                  Effect.andThen(child.interrupt),
                  Effect.andThen(Effect.interrupt),
                ),
              );
              yield* Fiber.join(forward);
              onUpdate?.({
                content: [{ type: "text", text: result.message }],
                details: { childSessionId: session.id },
              });
              return {
                content: [{ type: "text" as const, text: result.message }],
                details: { childSessionId: session.id },
              };
            }),
          );
          return Effect.runPromise(program);
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
