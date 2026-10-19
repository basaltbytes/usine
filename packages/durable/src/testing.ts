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
  AgentBlockedError,
  AgentQuestionError,
  type AgentReport,
  AgentResultError,
  type AgentSessionError,
  ChildBackend,
  type ChildRequest,
  type OnDelivery,
  reportText,
  type RunningSession,
  SessionResult,
} from "@usine/agents/runtime";
import { ModelId } from "@usine/core/agent/brain";
import {
  type AgentSessionEvent,
  AgentSessionId,
  ParentSession,
  SessionFinished,
  SessionIdle,
  SessionResumed,
  SessionStarted,
  TextOutput,
} from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { StepResult } from "@usine/core/step/result";
import {
  type Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Stream,
} from "effect";
import {
  AttemptReport,
  type AttemptRequest,
  AttemptRuntime,
  type FinishedAttempt,
  ParentReported,
  ResultRecorded,
  StoredRequest,
} from "./attempt-runtime.ts";
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
  /** The request the parent's `subagent` call launched the child with: its session, prompt, checkout, and environment. */
  readonly request: ChildRequest;
  /** Adds one event to the child's stream. */
  readonly emit: (event: AgentSessionEvent) => Effect.Effect<void>;
  /**
   * Finishes with `message` as the child's report; under a Hold the report
   * waits for the release. The turn it ends read every queued operator message.
   */
  readonly reply: (message: string) => Effect.Effect<void>;
  /** Reads the operator messages the child queued while it worked, as a harness does at its next boundary. */
  readonly readQueued: Effect.Effect<void>;
  /** Finishes with a blocked report, which fails the Attempt unless the parent relays it. */
  readonly block: (message: string) => Effect.Effect<void>;
  /** Finishes by asking the operator `question`, which fails the Attempt unless the parent relays it. */
  readonly ask: (question: string) => Effect.Effect<void>;
  /** Finishes with a harness failure, which fails the Attempt with `AgentFailure` unless the parent reports otherwise. */
  readonly fail: (message: string) => Effect.Effect<void>;
  /** Completes once the parent's tool call interrupted the child (abort, cancel, or shutdown). */
  readonly interrupted: Effect.Effect<void>;
  /** The operator actions delivered to this child so far. */
  readonly interventions: Effect.Effect<ReadonlyArray<AttemptChannel.OperatorAction>>;
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
  const events = yield* Queue.make<AgentSessionEvent, AgentReport | Cause.Done>();
  const result = yield* Deferred.make<SessionResult, AgentSessionError>();
  const interrupted = yield* Deferred.make<void>();
  const interventions: Array<AttemptChannel.OperatorAction> = [];
  let held = false;
  let paused = false;
  let pending = Option.none<string>();
  const queued: Array<OnDelivery> = [];

  const stateNow = (isQueued: boolean) =>
    new AttemptChannel.InterventionState({ held, paused, queued: isQueued });
  const readQueued = Effect.suspend(() =>
    Effect.forEach(queued.splice(0), (onDelivery) => onDelivery(Option.some(stateNow(false))), {
      discard: true,
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() =>
      Effect.forEach(queued.splice(0), (onDelivery) => onDelivery(Option.none()), {
        discard: true,
      }),
    ),
  );

  const emit = (event: AgentSessionEvent) => Queue.offer(events, event).pipe(Effect.asVoid);
  const finish = (message: string) =>
    Effect.gen(function* () {
      yield* emit(new TextOutput({ session, text: message }));
      yield* emit(new SessionFinished({ session }));
      yield* Queue.end(events);
      yield* Deferred.succeed(result, new SessionResult({ message }));
    });
  const reply = (message: string) =>
    readQueued.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (!held) return finish(message);
          pending = Option.some(message);
          return emit(new SessionIdle({ session }));
        }),
      ),
    );
  const report = (error: AgentReport) =>
    Effect.gen(function* () {
      yield* readQueued;
      yield* emit(new TextOutput({ session, text: reportText(error) }));
      yield* Queue.fail(events, error);
      yield* Deferred.fail(result, error);
    });
  const block = (message: string) =>
    report(new AgentBlockedError({ sessionId: Option.some(session.id), message }));
  const ask = (question: string) =>
    report(new AgentQuestionError({ sessionId: Option.some(session.id), message: question }));
  const fail = (message: string) =>
    report(new AgentResultError({ sessionId: Option.some(session.id), message }));
  // A message to an idle or paused child starts its next turn; a working child queues it.
  const intervene = (action: AttemptChannel.OperatorAction, onDelivery: OnDelivery) =>
    Effect.gen(function* () {
      interventions.push(action);
      if (action._tag === "OperatorMessage" || action._tag === "Steer") {
        if (action._tag === "OperatorMessage") held = true;
        const stopped = Option.isSome(pending) || paused;
        paused = false;
        if (!stopped) {
          queued.push(onDelivery);
          return stateNow(true);
        }
        pending = Option.none();
        yield* emit(new SessionResumed({ session }));
      } else if (action._tag === "Release") {
        held = false;
        if (Option.isSome(pending)) yield* finish(pending.value);
      } else {
        paused = true;
      }
      return stateNow(false);
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
    readQueued,
    block,
    ask,
    fail,
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

/** What a scripted stub parent can do while `execute` runs it. */
export interface StubParentContext {
  /**
   * The request this `execute` call received. When the call reattaches a task, this is the new
   * call's request, not the one the task was created with.
   */
  readonly request: AttemptRequest;
  /** Records one outbound envelope with the task's next sequence. */
  readonly emit: (payload: AttemptChannel.OutboundPayload) => Effect.Effect<void, AttemptFailure>;
  /** The parent session the stub reports events for. */
  readonly session: ParentSession;
  /** Whether this `execute` call reattached a task a previous runtime started. */
  readonly reattached: boolean;
}

/** A stub parent's work after Started; its result is the parent's final message, or its whole report. */
export type StubParent = (
  context: StubParentContext,
) => Effect.Effect<string | AttemptReport, AttemptFailure>;

type StubTaskState =
  | { readonly _tag: "live" }
  | { readonly _tag: "finished"; readonly report: AttemptReport; result: Option.Option<StepResult> }
  | { readonly _tag: "canceled" };

interface StubTask {
  readonly request: AttemptRequest;
  state: StubTaskState;
  outbound: number;
  inbound: number;
}

/**
 * The durable storage behind stub runtimes: tasks and their sequence counters
 * survive a runtime being closed and built again, as pi-durable storage
 * survives an orchestrator restart.
 */
export class StubStorage {
  /**
   * Each Attempt's stub task by Attempt id, with the request that created it and its state:
   * `live`, `finished` with its report, or `canceled`. Tests read the state to check whether
   * the executor canceled an Attempt.
   */
  readonly tasks = new Map<AttemptId, StubTask>();
}

/** Completes at once with `Completed: <task>`. */
export const completes: StubParent = ({ request }) =>
  Effect.succeed(`Completed: ${request.spec.task}`);

/** Works for `millis` before completing. */
export const worksFor =
  (millis: number): StubParent =>
  (context) =>
    Effect.sleep(`${millis} millis`).pipe(Effect.andThen(completes(context)));

/**
 * An in-memory `AttemptRuntime` over `storage`, for executor and engine tests
 * that need no parent model. It records Started, the parent's session events,
 * intervention receipts, Worker notices sent while `execute` runs, and a Final
 * without facts (the executor harvests those) through the Attempt's sink,
 * numbering them per task so a reattached `execute` continues the sequence.
 * Only a completed parent leaves the live
 * state: interrupting `execute` (a stopped process) or a failing parent leaves
 * the task live until someone cancels it, so tests see whether the executor
 * stopped it. A completed task keeps its report, which a later `execute`
 * returns and `finished` reports until `recordResult` replaces it.
 */
export const stubAttemptRuntime = (storage: StubStorage, parent: StubParent = completes) =>
  Layer.effect(
    AttemptRuntime,
    Effect.sync(() => {
      const attached = new Map<
        AttemptId,
        { readonly io: AttemptChannel.Sink; readonly canceled: Deferred.Deferred<void> }
      >();
      const envelope = (task: StubTask, payload: AttemptChannel.OutboundPayload) =>
        Effect.map(
          DateTime.now,
          (sentAt) =>
            new AttemptChannel.OutboundEnvelope({
              version: AttemptChannel.PROTOCOL_VERSION,
              attemptId: task.request.spec.attemptId,
              sequence: AttemptChannel.Sequence.make(++task.outbound),
              sentAt,
              payload,
            }),
        );

      const execute = (request: AttemptRequest, io: AttemptChannel.Sink) =>
        Effect.gen(function* () {
          const attemptId = request.spec.attemptId;
          const stored = storage.tasks.get(attemptId);
          if (stored?.state._tag === "finished") return stored.state.report;
          if (stored?.state._tag === "canceled")
            return yield* new InfraFailure({
              message: `Attempt ${attemptId} has no live task`,
              cause: new Error(stored.state._tag),
            });
          const task: StubTask = stored ?? {
            request,
            state: { _tag: "live" },
            outbound: 0,
            inbound: 0,
          };
          storage.tasks.set(attemptId, task);
          const canceled = yield* Deferred.make<void>();
          attached.set(attemptId, { io, canceled });
          const session = new ParentSession({
            id: AgentSessionId.make(`parent:${attemptId}`),
            agent: request.spec.agent.name,
            brain: request.spec.agent.brain,
          });
          const emit = (payload: AttemptChannel.OutboundPayload) =>
            Effect.flatMap(envelope(task, payload), (sent) => io.append("outbound", sent));
          const event = (event: AttemptChannel.SessionEvent["event"]) =>
            emit(new AttemptChannel.SessionEvent({ event }));
          if (stored === undefined) {
            yield* emit(
              new AttemptChannel.Started({
                parentModel: Option.getOrElse(request.spec.parentModel, () =>
                  ModelId.make("stub/parent"),
                ),
              }),
            );
            yield* event(new SessionStarted({ session }));
            yield* event(new TextOutput({ session, text: `Working on ${request.spec.task}` }));
          } else {
            yield* event(new TextOutput({ session, text: "Resumed after a restart" }));
          }
          const finished = yield* parent({
            request,
            emit,
            session,
            reattached: stored !== undefined,
          }).pipe(
            Effect.raceFirst(
              Deferred.await(canceled).pipe(
                Effect.andThen(
                  Effect.fail(new AgentFailure({ message: "The parent task was canceled" })),
                ),
              ),
            ),
          );
          const report =
            finished instanceof AttemptReport ? finished : new AttemptReport({ message: finished });
          yield* event(new SessionFinished({ session }));
          yield* emit(
            new AttemptChannel.Final({
              result: new StepResult({ message: report.message, facts: [] }),
            }),
          );
          task.state = { _tag: "finished", report, result: Option.none() };
          return report;
        }).pipe(Effect.ensuring(Effect.sync(() => attached.delete(request.spec.attemptId))));

      return AttemptRuntime.of({
        execute,
        isLive: (attemptId) =>
          Effect.sync(() => storage.tasks.get(attemptId)?.state._tag === "live"),
        finished: (attemptId) =>
          Effect.sync(() => {
            const state = storage.tasks.get(attemptId)?.state;
            if (state?._tag !== "finished") return Option.none<FinishedAttempt>();
            return Option.some(
              Option.match(state.result, {
                onNone: (): FinishedAttempt => new ParentReported({ report: state.report }),
                onSome: (result) => new ResultRecorded({ result }),
              }),
            );
          }),
        recordResult: (attemptId, result) =>
          Effect.sync(() => {
            const state = storage.tasks.get(attemptId)?.state;
            if (state?._tag === "finished") state.result = Option.some(result);
          }),
        request: (attemptId) =>
          Effect.sync(() =>
            Option.map(
              Option.fromNullishOr(storage.tasks.get(attemptId)),
              ({ request }) =>
                new StoredRequest({ spec: request.spec, worker: request.worker, cwd: request.cwd }),
            ),
          ),
        cancel: (attemptId) =>
          Effect.gen(function* () {
            const task = storage.tasks.get(attemptId);
            if (task === undefined || task.state._tag !== "live") return;
            task.state = { _tag: "canceled" };
            const active = attached.get(attemptId);
            if (active !== undefined) yield* Deferred.succeed(active.canceled, undefined);
          }),
        notify: (attemptId, notice) =>
          Effect.gen(function* () {
            const task = storage.tasks.get(attemptId);
            const active = attached.get(attemptId);
            if (task === undefined || active === undefined) return;
            yield* active.io.append("outbound", yield* envelope(task, notice));
          }).pipe(Effect.orDie),
        intervene: (attemptId, intervention) =>
          Effect.gen(function* () {
            const task = storage.tasks.get(attemptId);
            const active = attached.get(attemptId);
            if (task === undefined || active === undefined)
              return yield* new AgentFailure({ message: "This Attempt has no live parent" });
            const inputSequence = AttemptChannel.Sequence.make(++task.inbound);
            yield* active.io.append(
              "inbound",
              new AttemptChannel.InboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: inputSequence,
                sentAt: yield* DateTime.now,
                target: intervention.target,
                operator: intervention.operator,
                payload: intervention.action,
              }),
            );
            yield* active.io.append(
              "outbound",
              yield* envelope(
                task,
                new AttemptChannel.InterventionApplied({
                  inputSequence,
                  intervention,
                  state: new AttemptChannel.InterventionState({ held: false, paused: false }),
                }),
              ),
            );
          }),
      });
    }),
  );
