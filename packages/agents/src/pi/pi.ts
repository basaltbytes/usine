import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@usine/core";
import { Context, Deferred, Effect, Fiber, Layer, Option, Queue, Schema, Stream } from "effect";
import { assemblePrompt } from "../prompt.ts";
import {
  type AgentSessionError,
  AgentRuntime,
  ChildBackend,
  type LaunchRequest,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
} from "../runtime.ts";
import { sessionChannel } from "./session.ts";
import { subagentsExtension } from "./subagents.ts";

export type PiSessionEvent = AgentSessionEvent;
type PiMessage = Awaited<ReturnType<typeof createAgentSession>>["session"]["messages"][number];

/** Narrow in-process Pi session surface consumed by the adapter. */
export interface PiSession {
  readonly messages: ReadonlyArray<PiMessage>;
  readonly subscribe: (listener: (event: PiSessionEvent) => void) => () => void;
  readonly prompt: (prompt: string) => Promise<void>;
  readonly steer: (message: string) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
}

export interface PiStartOptions {
  readonly cwd: string;
  readonly extensions: ReadonlyArray<InlineExtension>;
  readonly model: Option.Option<Agent.ModelId>;
  readonly thinkingLevel: Agent.Effort;
}

export type PiStartResult =
  | { readonly _tag: "UnknownModel" }
  | { readonly _tag: "Started"; readonly model: Agent.ModelId; readonly session: PiSession };

/** Narrow SDK seam keeps vendor setup testable without module replacement. */
export class PiSdk extends Context.Service<
  PiSdk,
  { readonly start: (options: PiStartOptions) => Promise<PiStartResult> }
>()("@usine/agents/pi/PiSdk") {}

const splitModel = (model: Agent.ModelId): readonly [string, string] | undefined => {
  const separator = model.indexOf("/");
  return separator <= 0 || separator === model.length - 1
    ? undefined
    : [model.slice(0, separator), model.slice(separator + 1)];
};

export const piSdkLive = Layer.succeed(PiSdk)({
  start: async (options) => {
    const modelRuntime = await ModelRuntime.create();
    let selected: ReturnType<ModelRuntime["getModel"]>;
    if (Option.isSome(options.model)) {
      const parts = splitModel(options.model.value);
      if (parts === undefined) return { _tag: "UnknownModel" };
      selected = modelRuntime.getModel(parts[0], parts[1]);
      if (selected === undefined) return { _tag: "UnknownModel" };
    }
    const agentDir = getAgentDir();
    // The Attempt worktree is repository-controlled input: never trust its
    // `.pi/` settings, SYSTEM.md, extensions, or skills. The subagents tool
    // arrives as an inline factory, which the loader registers regardless.
    const settingsManager = SettingsManager.create(options.cwd, agentDir, {
      projectTrusted: false,
    });
    const resourceLoader = new DefaultResourceLoader({
      agentDir,
      cwd: options.cwd,
      extensionFactories: [...options.extensions],
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    const sessionOptions = {
      cwd: options.cwd,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager,
      thinkingLevel: options.thinkingLevel,
    } as const;
    const { session } =
      selected === undefined
        ? await createAgentSession(sessionOptions)
        : await createAgentSession({ ...sessionOptions, model: selected });
    const active = session.model;
    if (active === undefined) {
      session.dispose();
      throw new Error("Pi started without an active model");
    }
    return {
      _tag: "Started",
      model: Agent.ModelId.make(`${active.provider}/${active.id}`),
      session,
    };
  },
});

const PiAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
});
const PiTextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const decodeSerializedJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
type PiToolStartedEvent = Extract<PiSessionEvent, { readonly type: "tool_execution_start" }>;
type PiToolFinishedEvent = Extract<PiSessionEvent, { readonly type: "tool_execution_end" }>;

const toolInputJson = (event: PiToolStartedEvent): Schema.Json => {
  try {
    return decodeSerializedJson(JSON.stringify(event.args) ?? "null");
  } catch {
    return String(event.args);
  }
};

const toolOutputJson = (event: PiToolFinishedEvent): Schema.Json => {
  try {
    return decodeSerializedJson(JSON.stringify(event.result) ?? "null");
  } catch {
    return String(event.result);
  }
};

const messageText = (message: PiMessage): string | undefined => {
  if (!Schema.is(PiAssistantMessage)(message)) return undefined;
  if (Schema.is(Schema.String)(message.content)) return message.content.trim() || undefined;
  const text = message.content
    .filter(Schema.is(PiTextBlock))
    .map(({ text }) => text)
    .join("")
    .trim();
  return text || undefined;
};

const lastMessageText = (messages: ReadonlyArray<PiMessage>): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const text = messageText(message);
    if (text !== undefined) return text;
  }
  return undefined;
};

const sessionEventFrom = (
  event: PiSessionEvent,
  session: Agent.ParentSession,
): Agent.SessionEvent | undefined => {
  if (event.type === "message_end") {
    const text = messageText(event.message);
    return text === undefined ? undefined : new Agent.TextOutput({ session, text });
  }
  if (event.type === "tool_execution_start") {
    return new Agent.ToolStarted({
      session,
      callId: event.toolCallId,
      tool: event.toolName,
      input: toolInputJson(event),
    });
  }
  if (event.type === "tool_execution_end") {
    return new Agent.ToolFinished({
      session,
      callId: event.toolCallId,
      tool: event.toolName,
      output: toolOutputJson(event),
      isError: event.isError,
    });
  }
  return undefined;
};

const parentError = (
  operation: SessionOperationError["operation"],
  request: LaunchRequest,
  message: string,
  cause: unknown,
) =>
  new SessionOperationError({
    operation,
    sessionId: Option.some(Agent.SessionId.make(`parent:${request.spec.attemptId}`)),
    message,
    cause,
  });

const makePiParent = Effect.gen(function* () {
  const children = yield* ChildBackend;
  const sdk = yield* PiSdk;

  const launch: AgentRuntime["Service"]["launch"] = Effect.fn("PiParentRuntime.launch")(
    function* (request) {
      const parentId = Agent.SessionId.make(`parent:${request.spec.attemptId}`);
      yield* Effect.annotateCurrentSpan({
        agent: request.spec.agent.name,
        attemptId: request.spec.attemptId,
        effort: request.spec.agent.brain.effort,
        parentModel: Option.getOrUndefined(request.spec.parentModel),
        repository: request.spec.repository,
        sessionId: parentId,
      });
      yield* Effect.logInfo("Launching Pi parent session");
      const channel = yield* sessionChannel({ label: "Pi parent session", sessionId: parentId });
      // The Pi tool callback runs outside any usine fiber. Child programs must
      // still carry this fiber's services (stderr logging, tracing) and die
      // with this launch scope, so the extension receives a runner instead of
      // reaching for the default runtime.
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<never>();
      const runChild = <A>(program: Effect.Effect<A, AgentSessionError>): Promise<A> =>
        Effect.runPromise(
          program.pipe(
            Effect.provideContext(context),
            Effect.forkIn(scope),
            Effect.flatMap(Fiber.join),
          ),
        );
      const emitChild = (event: Agent.SessionEvent) =>
        Queue.offer(channel.events, event).pipe(
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.void
              : Effect.logWarning("Dropped a child session event after the parent terminal", {
                  sessionId: parentId,
                  event: event._tag,
                }),
          ),
        );
      const started = yield* Effect.tryPromise({
        try: () =>
          sdk.start({
            cwd: request.cwd,
            extensions: [
              subagentsExtension({
                agent: request.spec.agent,
                backend: children,
                cwd: request.cwd,
                emit: emitChild,
                parentId,
                run: runChild,
              }),
            ],
            model: request.spec.parentModel,
            thinkingLevel: request.spec.agent.brain.effort,
          }),
        catch: (cause) =>
          parentError("launch", request, "Pi parent session failed to start", cause),
      });
      if (started._tag === "UnknownModel") {
        const model = Option.getOrElse(request.spec.parentModel, () =>
          Agent.ModelId.make("unknown"),
        );
        yield* Effect.logError("Pi parent rejected an unknown model", { model });
        return yield* new UnknownModelError({
          harness: "pi",
          model,
          message: `Pi does not expose model ${model}`,
        });
      }
      const parent = new Agent.ParentSession({
        id: parentId,
        agent: request.spec.agent.name,
        brain: new Agent.BrainSpec({
          harness: "pi",
          model: started.model,
          effort: request.spec.agent.brain.effort,
        }),
      });
      let lastText: string | undefined;
      yield* Queue.offer(channel.events, new Agent.SessionStarted({ session: parent }));
      const unsubscribe = started.session.subscribe((event) => {
        const sessionEvent = sessionEventFrom(event, parent);
        if (sessionEvent === undefined) return;
        if (sessionEvent._tag === "TextOutput") lastText = sessionEvent.text;
        // The subscription is removed on the terminal transition, so a false
        // return can only occur in the transition's own instant.
        Queue.offerUnsafe(channel.events, sessionEvent);
      });
      channel.onTerminal(unsubscribe);

      const prompt = assemblePrompt({
        repository: request.spec.repository,
        payload: request.spec.payload,
        agent: request.spec.agent.name,
        persona: request.spec.agent.persona,
        task: request.spec.task,
      });
      const run = Effect.tryPromise({
        try: () => started.session.prompt(prompt),
        catch: (cause) => parentError("stream", request, "Pi parent session failed", cause),
      }).pipe(
        Effect.flatMap(() =>
          channel.finish(
            parent,
            lastText ?? lastMessageText(started.session.messages) ?? "Pi parent session completed",
          ),
        ),
        Effect.catch((error) => channel.fail(error)),
      );
      yield* Effect.forkScoped(run);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe();
          started.session.dispose();
        }),
      );

      const steer = Effect.fn("PiParentRuntime.steer")((message: string) =>
        Effect.logDebug("Steering Pi parent session", { sessionId: parentId }).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => started.session.steer(message),
              catch: (cause) => parentError("steer", request, "Could not steer Pi", cause),
            }),
          ),
        ),
      );
      const interrupt = Effect.logInfo("Interrupting Pi parent session", {
        sessionId: parentId,
      }).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => started.session.abort(),
            catch: (cause) => parentError("interrupt", request, "Could not interrupt Pi", cause),
          }),
        ),
      );
      return {
        events: Stream.fromQueue(channel.events),
        interrupt,
        result: Deferred.await(channel.result),
        steer,
      } satisfies RunningSession;
    },
  );
  return AgentRuntime.of({ launch });
});

export const piParentLayer = Layer.effect(AgentRuntime, makePiParent);
