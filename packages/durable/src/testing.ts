import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  AgentResultError,
  type AgentSessionError,
  ChildBackend,
  type ChildRequest,
  type RunningSession,
  SessionResult,
} from "@usine/agents/runtime";
import { ModelId } from "@usine/core/agent/brain";
import {
  type AgentSessionEvent,
  SessionFinished,
  SessionIdle,
  SessionResumed,
  SessionStarted,
  TextOutput,
} from "@usine/core/agent/session";
import { InterventionState, type OperatorAction } from "@usine/core/attempt/channel";
import { BLOCKED_MARKER } from "@usine/agents/runtime";
import { type Cause, Context, Deferred, Effect, Layer, Option, Queue, Stream } from "effect";
import { layer as attemptRuntimeLayer } from "./attempt/runtime.ts";
import { SUBAGENT_TOOL } from "./attempt/subagent.ts";
import {
  type DurableHarnessOptions,
  durableError,
  layer as durableHarnessLayer,
} from "./harness.ts";

/** One scripted answer of the parent's model, or a function of the request that returns one. */
export type ParentStep = FauxResponseStep;

/** The parent model the testing layer serves; name it in `RunSpec.parentModel` or leave that empty. */
export const PARENT_MODEL = ModelId.make("faux/faux-1");

/** The parent delegates `task` to one child through the `subagent` tool. */
export const delegate = (task: string): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(SUBAGENT_TOOL, { task })], { stopReason: "toolUse" });

/** The parent gives its final answer. */
export const answer = (text: string): AssistantMessage => fauxAssistantMessage([fauxText(text)]);

/** pi-ai model access that answers the parent's requests with `steps`, in order; it accepts every reasoning effort up to `high`. */
export const fauxParent = (
  steps: ReadonlyArray<ParentStep>,
): Pick<DurableHarnessOptions, "models" | "defaultModel"> => {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...steps]);
  const defaultModel: ModelRef = { provider: faux.provider.id, modelId: "faux-1" };
  return { models, defaultModel: Option.some(defaultModel) };
};

/** One child the stub backend launched; the test decides when and how it finishes. */
export interface StubChild {
  readonly request: ChildRequest;
  /** Adds one event to the child's stream. */
  readonly emit: (event: AgentSessionEvent) => Effect.Effect<void>;
  /** Finishes with `message` as the child's report; under a Hold the report waits for the release. */
  readonly reply: (message: string) => Effect.Effect<void>;
  /** Finishes with a blocked report, which fails the Attempt unless the parent relays it. */
  readonly block: (message: string) => Effect.Effect<void>;
  /** Completes once the parent's tool call interrupted the child (abort, cancel, or shutdown). */
  readonly interrupted: Effect.Effect<void>;
  /** The operator actions delivered to this child so far. */
  readonly interventions: Effect.Effect<ReadonlyArray<OperatorAction>>;
}

/** The children the stub backend launched, in launch order. */
export class StubChildren extends Context.Service<
  StubChildren,
  {
    /** Waits for the next child the parent launches. */
    readonly next: Effect.Effect<StubChild>;
  }
>()("@usine/durable/testing/StubChildren") {}

const launchStub = Effect.fn("StubChildBackend.launch")(function* (request: ChildRequest) {
  const session = request.session;
  const events = yield* Queue.make<AgentSessionEvent, AgentResultError | Cause.Done>();
  const result = yield* Deferred.make<SessionResult, AgentSessionError>();
  const interrupted = yield* Deferred.make<void>();
  const interventions: Array<OperatorAction> = [];
  let held = false;
  let pending = Option.none<string>();

  const emit = (event: AgentSessionEvent) => Queue.offer(events, event).pipe(Effect.asVoid);
  const finish = (message: string) =>
    Effect.gen(function* () {
      yield* emit(new TextOutput({ session, text: message }));
      yield* emit(new SessionFinished({ session }));
      yield* Queue.end(events);
      yield* Deferred.succeed(result, new SessionResult({ message }));
    });
  const reply = (message: string) =>
    Effect.suspend(() => {
      if (!held) return finish(message);
      pending = Option.some(message);
      return emit(new SessionIdle({ session }));
    });
  const block = (message: string) =>
    Effect.gen(function* () {
      const error = new AgentResultError({ sessionId: Option.some(session.id), message });
      yield* emit(new TextOutput({ session, text: `${BLOCKED_MARKER}\n${message}` }));
      yield* Queue.fail(events, error);
      yield* Deferred.fail(result, error);
    });
  const intervene = (action: OperatorAction) =>
    Effect.gen(function* () {
      interventions.push(action);
      if (action._tag === "OperatorMessage") {
        held = true;
        yield* emit(new SessionResumed({ session }));
      } else if (action._tag === "Steer") {
        yield* emit(new SessionResumed({ session }));
      } else if (action._tag === "Release") {
        held = false;
        if (Option.isSome(pending)) yield* finish(pending.value);
      }
      return new InterventionState({ held, paused: action._tag === "Interrupt" });
    });

  yield* emit(new SessionStarted({ session }));
  const running: RunningSession = {
    session,
    events: Stream.fromQueue(events),
    result: Deferred.await(result),
    steer: () => Effect.void,
    interrupt: Deferred.succeed(interrupted, undefined).pipe(
      Effect.andThen(Queue.end(events)),
      Effect.asVoid,
    ),
    intervene,
  };
  const child: StubChild = {
    request,
    emit,
    reply,
    block,
    interrupted: Deferred.await(interrupted),
    interventions: Effect.sync(() => [...interventions]),
  };
  return { running, child };
});

/** A `ChildBackend` whose children run only as the test scripts them through `StubChildren`. */
export const stubChildBackendLayer: Layer.Layer<ChildBackend | StubChildren> = Layer.effectContext(
  Effect.gen(function* () {
    const launched = yield* Queue.unbounded<StubChild>();
    return Context.make(
      ChildBackend,
      ChildBackend.of({
        launch: (request) =>
          launchStub(request).pipe(
            Effect.tap(({ child }) => Queue.offer(launched, child)),
            Effect.map(({ running }) => running),
          ),
      }),
    ).pipe(Context.add(StubChildren, StubChildren.of({ next: Queue.take(launched) })));
  }),
);

/** What the testing layer runs on. */
export interface DurableTestingOptions {
  /** The SQLite file; build another layer on the same file to simulate an orchestrator restart. */
  readonly database: string;
  /** The parent model's answers, one per model request, in order. */
  readonly parent: ReadonlyArray<ParentStep>;
}

/**
 * The durable Attempt runtime on a SQLite file with a scripted parent model
 * and stub children, for driving whole Attempts in tests without a model or a
 * harness binary.
 */
export const layer = (options: DurableTestingOptions) =>
  attemptRuntimeLayer.pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.sync(() =>
          durableHarnessLayer({
            ...fauxParent(options.parent),
            openStorage: Effect.tryPromise({
              try: () => openNodeSqliteStorage(options.database),
              catch: (cause) => durableError("open the durable storage", cause),
            }),
          }),
        ),
      ),
    ),
    Layer.provideMerge(stubChildBackendLayer),
  );
