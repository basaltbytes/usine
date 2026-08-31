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
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { assemblePrompt } from "../prompt.ts";
import {
  type AgentSessionError,
  AgentRuntime,
  ChildBackend,
  type LaunchRequest,
  type RunningSession,
  SessionOperationError,
  SessionResult,
  UnknownModelError,
} from "../runtime.ts";
import { subagentsExtension } from "./subagents.ts";

export type PiSessionEvent = AgentSessionEvent;

/** Narrow in-process Pi session surface consumed by the adapter. */
export interface PiSession {
  readonly messages: ReadonlyArray<unknown>;
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
    const settingsManager = SettingsManager.create(options.cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      agentDir,
      cwd: options.cwd,
      extensionFactories: [...options.extensions],
      settingsManager,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: options.cwd,
      ...(selected === undefined ? {} : { model: selected }),
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager,
      thinkingLevel: options.thinkingLevel,
    });
    const active = session.model;
    if (active === undefined) throw new Error("Pi started without an active model");
    return {
      _tag: "Started",
      model: Agent.ModelId.make(`${active.provider}/${active.id}`),
      session,
    };
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const messageText = (message: unknown): string | undefined => {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  const content = message.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("")
    .trim();
  return text || undefined;
};

const asJson = (value: unknown): Schema.Json => {
  try {
    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)));
  } catch {
    return String(value);
  }
};

const lastMessageText = (messages: ReadonlyArray<unknown>): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index]);
    if (text !== undefined) return text;
  }
  return undefined;
};

const activityFrom = (
  event: PiSessionEvent,
  session: Agent.ParentSession,
): Agent.Activity | undefined => {
  if (event.type === "message_end") {
    const text = messageText(event.message);
    return text === undefined ? undefined : new Agent.TextOutput({ session, text });
  }
  if (event.type === "tool_execution_start") {
    return new Agent.ToolStarted({
      session,
      callId: event.toolCallId,
      tool: event.toolName,
      input: asJson(event.args),
    });
  }
  if (event.type === "tool_execution_end") {
    return new Agent.ToolFinished({
      session,
      callId: event.toolCallId,
      tool: event.toolName,
      output: asJson(event.result),
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
      const events = yield* Queue.make<Agent.Activity, AgentSessionError | Cause.Done>();
      const emitChild = (activity: Agent.Activity) =>
        Effect.sync(() => {
          Queue.offerUnsafe(events, activity);
        });
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
              }),
            ],
            model: request.spec.parentModel,
            thinkingLevel: request.spec.agent.effort,
          }),
        catch: (cause) =>
          parentError("launch", request, "Pi parent session failed to start", cause),
      });
      if (started._tag === "UnknownModel") {
        const model = Option.getOrElse(request.spec.parentModel, () =>
          Agent.ModelId.make("unknown"),
        );
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
          effort: request.spec.agent.effort,
        }),
      });
      const result = yield* Deferred.make<SessionResult, AgentSessionError>();
      const terminal = yield* Ref.make(false);
      let lastText: string | undefined;
      yield* Queue.offer(events, new Agent.SessionStarted({ session: parent }));
      const unsubscribe = started.session.subscribe((event) => {
        const activity = activityFrom(event, parent);
        if (activity === undefined) return;
        if (activity._tag === "TextOutput") lastText = activity.text;
        Queue.offerUnsafe(events, activity);
      });

      const fail = Effect.fn("PiParentRuntime.fail")(function* (error: AgentSessionError) {
        if (yield* Ref.getAndSet(terminal, true)) return;
        yield* Deferred.fail(result, error);
        yield* Queue.fail(events, error);
      });
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
          Effect.gen(function* () {
            if (yield* Ref.getAndSet(terminal, true)) return;
            const message =
              lastText ??
              lastMessageText(started.session.messages) ??
              "Pi parent session completed";
            yield* Queue.offer(events, new Agent.SessionFinished({ session: parent }));
            yield* Deferred.succeed(result, new SessionResult({ message }));
            yield* Queue.end(events);
          }),
        ),
        Effect.catch((error) => fail(error)),
      );
      yield* Effect.forkScoped(run);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe();
          started.session.dispose();
        }),
      );

      const steer = Effect.fn("PiParentRuntime.steer")((message: string) =>
        Effect.tryPromise({
          try: () => started.session.steer(message),
          catch: (cause) => parentError("steer", request, "Could not steer Pi", cause),
        }),
      );
      const interrupt = Effect.tryPromise({
        try: () => started.session.abort(),
        catch: (cause) => parentError("interrupt", request, "Could not interrupt Pi", cause),
      });
      return {
        events: Stream.fromQueue(events),
        interrupt,
        result: Deferred.await(result),
        steer,
      } satisfies RunningSession;
    },
  );
  return AgentRuntime.of({ launch });
});

export const piParentLayer = Layer.effect(AgentRuntime, makePiParent);
