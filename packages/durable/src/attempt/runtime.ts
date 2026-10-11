import { LiveDoc } from "@earendil-works/pi-durable";
import { ChildBackend } from "@usine/agents/runtime";
import { SessionIdle, SessionResumed } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { type AttemptRequest, AttemptRuntime } from "../attempt-runtime.ts";
import { DurableHarness, type DurableHarnessError } from "../harness.ts";
import { AttemptRecordDoc, type Hold, HoldDoc } from "./documents.ts";
import { usineExtension } from "./extension.ts";
import { type AttemptHub, attemptHubs } from "./hubs.ts";
import { parentSessionId } from "./parent.ts";
import { appendInbound, emitPayload, readRecord, relayAttempt } from "./relay.ts";
import { readStoredRequest, taskInput } from "./request.ts";

/** The operator message that resumes an interrupted parent the operator released without guidance. */
const RELEASE_GUIDANCE =
  "The operator released the interrupt without further guidance. Continue the task.";

/** The operator input could not be applied; the transcript records why and the Attempt continues. */
class InterventionRefused extends Schema.TaggedError<InterventionRefused>(
  "@usine/durable/InterventionRefused",
)("InterventionRefused", { message: Schema.NonEmptyString }) {}

const refuse = (message: string) => new InterventionRefused({ message });

const infra = (error: DurableHarnessError) =>
  new InfraFailure({ message: error.message, cause: error });

const LIVE_STATUSES: ReadonlyArray<string> = ["pending", "running", "waiting"];

const makeAttemptRuntime = Effect.gen(function* () {
  const durable = yield* DurableHarness;
  const backend = yield* ChildBackend;
  const services = yield* Effect.context<never>();
  const hubs = yield* attemptHubs;
  const { extension, task } = usineExtension({
    hubs,
    backend,
    defaultModel: durable.defaultModel,
    run: (program, signal) => Effect.runPromiseWith(services)(program, { signal }),
  });
  yield* durable.install(extension);
  yield* durable.subscribe(hubs.listener);
  yield* durable.use("open the root conversation", (harness, context) => harness.root(context));
  yield* durable.resume;

  const createOrFind = Effect.fn("AttemptRuntime.createOrFind")(function* (
    request: AttemptRequest,
  ) {
    const attemptId = request.spec.attemptId;
    const input = taskInput(request);
    return yield* durable.use("create or find the Attempt task", async (harness, context) => {
      const root = await harness.root(context);
      return root.commit(async (tx) => {
        const record = await tx.doc(AttemptRecordDoc, attemptId, null);
        if (record.taskId !== null) return { taskId: record.taskId, created: false };
        const taskId = await tx.createTask(task, input, { ownership: { kind: "conversation" } });
        record.taskId = taskId;
        return { taskId, created: true };
      }, context);
    });
  });

  const execute = Effect.fn("AttemptRuntime.execute")(
    function* (request: AttemptRequest, io: AttemptChannel.Sink) {
      const attemptId = request.spec.attemptId;
      yield* Effect.annotateCurrentSpan({
        attemptId,
        sessionId: parentSessionId(attemptId),
        repository: request.spec.repository,
        worker: request.worker,
      });
      const found = yield* createOrFind(request);
      yield* Effect.logInfo(
        found.created
          ? "Created the Attempt's durable task"
          : "Reattached to the Attempt's durable task",
        { taskId: found.taskId },
      );
      const hub = yield* hubs.hub(attemptId, found.taskId);
      const settled = yield* relayAttempt(durable, hubs, hub, request, io);
      return yield* Result.match(settled, {
        onSuccess: (report) => Effect.logInfo("The Attempt completed").pipe(Effect.as(report)),
        onFailure: (failure) =>
          Effect.logInfo("The Attempt ended without success", { failure: failure._tag }).pipe(
            Effect.andThen(Effect.fail(failure)),
          ),
      });
    },
    (effect, request) =>
      effect.pipe(
        Effect.catchTag("DurableHarnessError", (error) => Effect.fail(infra(error))),
        Effect.annotateLogs({ attemptId: request.spec.attemptId }),
      ),
  );

  const isLive = Effect.fn("AttemptRuntime.isLive")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const record = yield* readRecord(durable, attemptId);
      const live = record !== undefined && record.taskId !== null && !record.terminalRelayed;
      yield* Effect.logDebug("Checked whether the Attempt is live", { attemptId, live });
      return live;
    },
    Effect.catchTag("DurableHarnessError", (error) => Effect.fail(infra(error))),
  );

  const request = Effect.fn("AttemptRuntime.request")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      return yield* readStoredRequest(durable, attemptId);
    },
    Effect.catchTag("DurableHarnessError", (error) => Effect.fail(infra(error))),
  );

  /** Commits a change to the Attempt's Hold document while the task is live; none means it already returned. */
  const supervise = <A>(hub: AttemptHub, change: (document: Hold) => A) =>
    durable.use("update the Hold", (harness, context) =>
      harness.commit(async (tx) => {
        const current = await tx.task(hub.taskId);
        if (current === undefined || !LIVE_STATUSES.includes(current.state.status)) {
          return Option.none<A>();
        }
        return Option.some(change(await tx.doc(HoldDoc, hub.taskId)));
      }, context),
    );

  const hold = (hub: AttemptHub, update: (held: ReadonlyArray<string>) => Array<string>) =>
    supervise(hub, (document) => {
      document.held = update(document.held);
    });

  const routeChild = Effect.fn("AttemptRuntime.routeChild")(function* (
    hub: AttemptHub,
    target: AttemptChannel.ChildTarget,
    action: AttemptChannel.OperatorAction,
  ) {
    const child = hub.children.get(target.sessionId);
    if (child === undefined) return yield* refuse("This session is no longer live");
    const state = yield* child
      .intervene(action)
      .pipe(Effect.mapError((error) => refuse(error.message)));
    if (action._tag === "OperatorMessage" || action._tag === "Release") {
      yield* hold(hub, (held) =>
        state.held
          ? [...held.filter((id) => id !== target.sessionId), target.sessionId]
          : held.filter((id) => id !== target.sessionId),
      );
    }
    return state;
  });

  const routeParent = Effect.fn("AttemptRuntime.routeParent")(function* (
    hub: AttemptHub,
    action: AttemptChannel.OperatorAction,
    inputSequence: AttemptChannel.Sequence,
  ) {
    if (Option.isNone(hub.session) || Option.isNone(hub.parent)) {
      return yield* refuse("The parent has not started yet");
    }
    const session = hub.session.value;
    const parent = hub.parent.value;
    const resumed = new AttemptChannel.InterventionState({ held: false, paused: false });
    const paused = new AttemptChannel.InterventionState({ held: false, paused: true });
    const guide = (message: string) =>
      supervise(hub, (document) => {
        if (!document.paused) return false;
        document.guidance = [...document.guidance, message];
        document.paused = false;
        return true;
      });
    if (action._tag === "Interrupt") {
      const marked = yield* supervise(hub, (document) => {
        const already = document.paused;
        document.paused = true;
        return already;
      });
      if (Option.isNone(marked)) return yield* refuse("This session has already returned");
      if (marked.value) return paused;
      yield* Effect.logInfo("Interrupting the Pi parent; it holds until the operator resumes it");
      yield* durable.use("abort the parent's turn", async (harness, context) => {
        const conversation = await harness.conversation(parent, context);
        await conversation?.abort(context);
      });
      yield* emitPayload(
        durable,
        hub,
        new AttemptChannel.SessionEvent({ event: new SessionIdle({ session }) }),
      );
      return paused;
    }
    if (action._tag === "Release") {
      const released = yield* guide(RELEASE_GUIDANCE);
      if (Option.isNone(released)) return yield* refuse("This session has already returned");
      if (!released.value) {
        return yield* refuse("Only an interrupted parent or a held child can be released");
      }
      yield* Effect.logInfo("Released the interrupted Pi parent");
    } else {
      const guided = yield* guide(action.message);
      if (Option.isNone(guided)) return yield* refuse("This session has already returned");
      if (guided.value) {
        yield* Effect.logInfo("Resuming the interrupted Pi parent with operator guidance");
      } else {
        const busy = yield* durable.use("read the parent's run", async (harness, context) => {
          const live = await harness.snapshot(LiveDoc, parent, context);
          return live?.run !== undefined;
        });
        if (!busy) return yield* refuse("This session has already returned");
        yield* durable.use("steer the parent", async (harness, context) => {
          const conversation = await harness.conversation(parent, context);
          await conversation?.submit(
            {
              type: "input",
              content: action.message,
              whenBusy: "steer",
              requestId: `intervention:${hub.attemptId}:${inputSequence}`,
            },
            context,
          );
        });
        yield* Effect.logInfo("Steered the busy Pi parent");
      }
    }
    yield* emitPayload(
      durable,
      hub,
      new AttemptChannel.SessionEvent({ event: new SessionResumed({ session }) }),
    );
    return resumed;
  });

  const intervene = Effect.fn("AttemptRuntime.intervene")(
    function* (attemptId: AttemptId, intervention: AttemptChannel.Intervention) {
      yield* Effect.annotateCurrentSpan({
        attemptId,
        target: intervention.target._tag,
        action: intervention.action._tag,
      });
      const found = hubs.find(attemptId);
      if (Option.isNone(found) || Option.isNone(found.value.channel)) {
        yield* Effect.logWarning("Operator input addressed an Attempt with no live channel", {
          action: intervention.action._tag,
        });
        return yield* new AgentFailure({ message: "This Attempt no longer has a live channel" });
      }
      const hub = found.value;
      yield* hub.routing.withPermits(1)(
        Effect.gen(function* () {
          const inputSequence = yield* appendInbound(
            durable,
            hub,
            intervention.operator,
            intervention.target,
            intervention.action,
          );
          const target = intervention.target;
          const applied = yield* (
            target._tag === "Child"
              ? routeChild(hub, target, intervention.action)
              : routeParent(hub, intervention.action, inputSequence)
          ).pipe(
            Effect.catchTag("DurableHarnessError", (error) => Effect.fail(refuse(error.message))),
            Effect.result,
          );
          if (Result.isFailure(applied)) {
            yield* Effect.logWarning("Session refused operator input", {
              action: intervention.action._tag,
              message: applied.failure.message,
            });
            yield* emitPayload(
              durable,
              hub,
              new AttemptChannel.InterventionRejected({
                inputSequence,
                intervention,
                message: applied.failure.message,
              }),
            );
            return;
          }
          yield* emitPayload(
            durable,
            hub,
            new AttemptChannel.InterventionApplied({
              inputSequence,
              intervention,
              state: applied.success,
            }),
          );
          yield* Effect.logInfo("Operator input applied", {
            action: intervention.action._tag,
            held: applied.success.held,
            paused: applied.success.paused,
          });
        }),
      );
    },
    (effect, attemptId) =>
      effect.pipe(
        Effect.catchTag("DurableHarnessError", (error) => Effect.fail(infra(error))),
        Effect.annotateLogs({ attemptId }),
      ),
  );

  const cancel = Effect.fn("AttemptRuntime.cancel")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const record = yield* readRecord(durable, attemptId);
      if (record === undefined || record.taskId === null) {
        yield* Effect.logInfo("The Attempt has no durable task; nothing to cancel");
        return;
      }
      const taskId = record.taskId;
      const hub = hubs.find(attemptId);
      if (Option.isSome(hub) && Option.isSome(hub.value.channel)) {
        yield* appendInbound(
          durable,
          hub.value,
          "engine",
          new AttemptChannel.ParentTarget(),
          new AttemptChannel.Cancel(),
        ).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not record the cancellation in the transcript", {
              errorTag: error._tag,
            }),
          ),
          Effect.ignore,
        );
      }
      const marked = yield* durable.use("abort the Attempt task", (harness, context) =>
        harness.abortTask(taskId, context),
      );
      yield* Effect.logInfo("Canceling the Attempt's durable task", { taskId, marked });
      yield* durable.use("wait for the canceled Attempt task", (harness, context) =>
        harness.waitForTask(taskId, context),
      );
      yield* Effect.logInfo("The canceled Attempt's task stopped", { taskId });
    },
    (effect, attemptId) =>
      effect.pipe(
        Effect.catchTag("DurableHarnessError", (error) => Effect.fail(infra(error))),
        Effect.annotateLogs({ attemptId }),
      ),
  );

  yield* Effect.logInfo("The durable Attempt runtime is ready");
  return AttemptRuntime.of({ execute, isLive, request, intervene, cancel });
});

/**
 * Runs Attempts on the durable harness. Building it installs the usine
 * extension and resumes the harness's tasks, so every unfinished Attempt
 * continues as soon as the orchestrator starts.
 */
export const layer = Layer.effect(AttemptRuntime, makeAttemptRuntime);
