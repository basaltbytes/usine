import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { ChildBackend } from "@usine/agents/runtime";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { StepResult } from "@usine/core/step/result";
import { Duration, Effect, Layer, Option, Result, Schema } from "effect";
import { type AttemptRequest, AttemptRuntime, type FinishedAttempt } from "../attempt-runtime.ts";
import { DurableHarness, type DurableHarnessError } from "../harness.ts";
import { AttemptRecordDoc, type Hold, HoldDoc, RELEASE_GUIDANCE } from "./documents.ts";
import { usineExtension } from "./extension.ts";
import { type AttemptHub, attemptHubs } from "./hubs.ts";
import { encodeResult, finishedOf } from "./outcome.ts";
import { parentSessionId } from "./parent.ts";
import { repairUnreadableConversations } from "./repair.ts";
import { appendInbound, emitPayload, readRecord, relayAttempt, relayDeliveries } from "./relay.ts";
import { readStoredRequest, taskInput } from "./request.ts";

/**
 * An operator input that couldn't be applied. The reason is recorded in the transcript and the
 * Attempt continues.
 */
class InterventionRefused extends Schema.TaggedError<InterventionRefused>(
  "@usine/durable/InterventionRefused",
)("InterventionRefused", { message: Schema.NonEmptyString }) {}

const refuse = (message: string) => new InterventionRefused({ message });

const infra = (error: DurableHarnessError) =>
  new InfraFailure({ message: error.message, cause: error });

const LIVE_STATUSES: ReadonlyArray<string> = ["pending", "running", "waiting"];

const encodeIntervention = Schema.encodeSync(AttemptChannel.Intervention);

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
  yield* durable.resume(repairUnreadableConversations);

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

  // An aborted task is never live: only `cancel` aborts a task, and every caller of `cancel` has
  // the engine close the Attempt.
  const isLive = Effect.fn("AttemptRuntime.isLive")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const record = yield* readRecord(durable, attemptId);
      if (record === undefined || record.taskId === null) {
        yield* Effect.logDebug("The Attempt has no durable task; it is not live", { attemptId });
        return false;
      }
      const taskId = record.taskId;
      const task = yield* durable.use("read the Attempt task", (harness, context) =>
        harness.getTask(taskId, context),
      );
      const outcome = task?.state.outcome?.status;
      const live = task !== undefined && outcome !== "aborted" && !record.terminalRelayed;
      yield* Effect.logDebug("Checked whether the Attempt is live", {
        attemptId,
        taskId,
        status: task?.state.status,
        outcome,
        terminalRelayed: record.terminalRelayed,
        live,
      });
      return live;
    },
    Effect.catchTag("DurableHarnessError", (error) => Effect.fail(infra(error))),
  );

  const finished = Effect.fn("AttemptRuntime.finished")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const record = yield* readRecord(durable, attemptId);
      if (record === undefined || record.taskId === null) return Option.none<FinishedAttempt>();
      const taskId = record.taskId;
      const task = yield* durable.use("read the Attempt task", (harness, context) =>
        harness.getTask(taskId, context),
      );
      const found = task === undefined ? Option.none<FinishedAttempt>() : finishedOf(record, task);
      if (
        record.result !== undefined &&
        Option.isSome(found) &&
        found.value._tag === "ParentReported"
      ) {
        yield* Effect.logWarning(
          "The Attempt's recorded result does not decode; its checkout is harvested again",
          { attemptId, taskId },
        );
      }
      yield* Effect.logDebug("Read what the Attempt's finished task left", {
        attemptId,
        taskId,
        terminalRelayed: record.terminalRelayed,
        outcome: task?.state.outcome?.status,
        finished: Option.match(found, { onNone: () => "none", onSome: ({ _tag }) => _tag }),
      });
      return found;
    },
    Effect.catchTag("DurableHarnessError", (error) => Effect.fail(infra(error))),
  );

  const recordResult = Effect.fn("AttemptRuntime.recordResult")(
    function* (attemptId: AttemptId, result: StepResult) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const encoded = encodeResult(result);
      yield* durable.use("record the Attempt's result", (harness, context) =>
        harness.commit(async (tx) => {
          const record = await tx.doc(AttemptRecordDoc, attemptId, null);
          record.result = encoded;
        }, context),
      );
      yield* Effect.logInfo("Recorded the Attempt's harvested result", {
        attemptId,
        facts: result.facts.length,
      });
    },
    Effect.catchTag("DurableHarnessError", (error) => Effect.fail(infra(error))),
  );

  const recordUnsupervised = Effect.fn("AttemptRuntime.recordUnsupervised")(
    function* (attemptId: AttemptId, unsupervised: Duration.Duration) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const millis = Duration.toMillis(unsupervised);
      const kept = yield* durable.use(
        "record the Attempt's unsupervised time",
        (harness, context) =>
          harness.commit(async (tx) => {
            const record = await tx.doc(AttemptRecordDoc, attemptId, null);
            record.unsupervisedMillis = Math.max(record.unsupervisedMillis ?? 0, millis);
            return record.unsupervisedMillis;
          }, context),
      );
      yield* Effect.logDebug("Recorded the Attempt's unsupervised time", {
        attemptId,
        unsupervisedMillis: millis,
        keptMillis: kept,
      });
    },
    Effect.catchTag("DurableHarnessError", (error) => Effect.fail(infra(error))),
  );

  const unsupervised = Effect.fn("AttemptRuntime.unsupervised")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const record = yield* readRecord(durable, attemptId);
      return Option.map(Option.fromNullishOr(record?.unsupervisedMillis), Duration.millis);
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

  /** Commits a change to the Hold document. Returns `None` if the task is no longer live. */
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

  /**
   * Applies operator input to a live child. A working child reads a message at its next turn
   * boundary, so the message is first reported as queued.
   */
  const routeChild = Effect.fn("AttemptRuntime.routeChild")(function* (
    hub: AttemptHub,
    target: AttemptChannel.ChildTarget,
    intervention: AttemptChannel.Intervention,
    inputSequence: AttemptChannel.Sequence,
  ) {
    const child = hub.children.get(target.sessionId);
    if (child === undefined) return yield* refuse("This session is no longer live");
    const action = intervention.action;
    const state = yield* child
      .intervene(action, (delivered) =>
        hubs.delivery(hub, { _tag: "Delivery", inputSequence, intervention, delivered }),
      )
      .pipe(Effect.mapError((error) => refuse(error.message)));
    if (action._tag === "OperatorMessage" || action._tag === "Release") {
      yield* hold(hub, (held) =>
        state.held
          ? [...held.filter((id) => id !== target.sessionId), target.sessionId]
          : held.filter((id) => id !== target.sessionId),
      );
    }
    if (state.queued) {
      hub.childInputs.add(inputSequence);
      yield* durable.use("record the queued operator input", (harness, context) =>
        harness.commit(async (tx) => {
          const record = await tx.doc(AttemptRecordDoc, hub.attemptId, null);
          record.queuedInputs = [
            ...(record.queuedInputs ?? []),
            {
              inputSequence,
              child: target.sessionId,
              intervention: encodeIntervention(intervention),
            },
          ];
        }, context),
      );
      yield* Effect.logInfo("The working child reads the operator input at its next boundary", {
        sessionId: target.sessionId,
        action: action._tag,
      });
    }
    return state;
  });

  /**
   * Commits a Hold change that depends on whether the parent is mid-turn. Returns `None` if the
   * task is no longer live.
   */
  const superviseParent = <A>(
    hub: AttemptHub,
    parent: ConversationId,
    change: (document: Hold, busy: boolean) => A,
  ) =>
    durable.use("update the parent's Hold", (harness, context) =>
      harness.commit(async (tx) => {
        const current = await tx.task(hub.taskId);
        if (current === undefined || !LIVE_STATUSES.includes(current.state.status)) {
          return Option.none<A>();
        }
        const live = await tx.doc(LiveDoc, parent);
        return Option.some(change(await tx.doc(HoldDoc, hub.taskId), live.run !== undefined));
      }, context),
    );

  /**
   * Applies operator input to the Pi parent (ADR 0018). An operator message places a Hold and a
   * steer doesn't; input to a working parent is reported as queued until the running tool call
   * returns.
   */
  const routeParent = Effect.fn("AttemptRuntime.routeParent")(function* (
    hub: AttemptHub,
    intervention: AttemptChannel.Intervention,
    inputSequence: AttemptChannel.Sequence,
  ) {
    if (Option.isNone(hub.parent)) return yield* refuse("The parent has not started yet");
    const parent = hub.parent.value;
    const parentId = parentSessionId(hub.attemptId);
    const action = intervention.action;
    const stateOf = (document: Hold, queued: boolean) =>
      new AttemptChannel.InterventionState({
        held: document.held.includes(parentId),
        paused: document.paused,
        queued,
      });
    if (action._tag === "Interrupt") {
      const marked = yield* supervise(hub, (document) => {
        const already = document.paused;
        document.paused = true;
        return { already, state: stateOf(document, false) };
      });
      if (Option.isNone(marked)) return yield* refuse("This session has already returned");
      if (marked.value.already) return marked.value.state;
      yield* Effect.logInfo("Interrupting the Pi parent; it holds until the operator resumes it");
      yield* durable.use("abort the parent's turn", async (harness, context) => {
        const conversation = await harness.conversation(parent, context);
        await conversation?.abort(context);
      });
      // The abort withdrew any queued operator input; send its rejection receipt.
      yield* relayDeliveries(durable, hub, "live");
      return marked.value.state;
    }
    if (action._tag === "Release") {
      const released = yield* superviseParent(hub, parent, (document, busy) => {
        if (!document.paused && !document.held.includes(parentId)) {
          return { _tag: "NotSupervised" } as const;
        }
        document.held = document.held.filter((id) => id !== parentId);
        // The interrupted turn may end after this commit, so add guidance for it to resume with.
        if (document.paused) {
          document.guidance = [...document.guidance, RELEASE_GUIDANCE];
          document.paused = false;
        }
        return { _tag: "Released", busy, state: stateOf(document, false) } as const;
      });
      if (Option.isNone(released)) return yield* refuse("This session has already returned");
      if (released.value._tag === "NotSupervised") {
        return yield* refuse("Only a paused or held session can be released");
      }
      yield* Effect.logInfo(
        released.value.busy
          ? "Released the working Pi parent; its next answer ends the Attempt"
          : "Released the waiting Pi parent; it continues the task",
      );
      return released.value.state;
    }
    const holds = action._tag === "OperatorMessage";
    const routed = yield* superviseParent(hub, parent, (document, busy) => {
      if (holds && !document.held.includes(parentId)) document.held = [...document.held, parentId];
      if (busy && !document.paused)
        return { _tag: "Steer", state: stateOf(document, true) } as const;
      document.guidance = [...document.guidance, action.message];
      document.paused = false;
      return { _tag: "NextTurn", state: stateOf(document, false) } as const;
    });
    if (Option.isNone(routed)) return yield* refuse("This session has already returned");
    if (routed.value._tag === "NextTurn") {
      yield* Effect.logInfo("The Pi parent takes the operator input as its next turn", {
        holds,
      });
      return routed.value.state;
    }
    const requestId = `intervention:${hub.attemptId}:${inputSequence}`;
    yield* durable.use("steer the parent", async (harness, context) => {
      const conversation = await harness.conversation(parent, context);
      await conversation?.submit(
        { type: "input", content: action.message, whenBusy: "steer", requestId },
        context,
      );
    });
    const queued = yield* durable.use("record the queued operator input", (harness, context) =>
      harness.commit(async (tx) => {
        const submission = await tx.submissionByRequest(parent, requestId);
        if (submission?.status !== "queued") return false;
        const record = await tx.doc(AttemptRecordDoc, hub.attemptId, null);
        record.queuedInputs = [
          ...(record.queuedInputs ?? []),
          {
            inputSequence,
            submission: submission.id,
            intervention: encodeIntervention(intervention),
          },
        ];
        return true;
      }, context),
    );
    if (queued) {
      yield* Effect.logInfo(
        "The working Pi parent reads the operator input when its running tool call returns",
        { holds },
      );
      return routed.value.state;
    }
    yield* Effect.logInfo("The Pi parent read the operator input at once", { holds });
    return new AttemptChannel.InterventionState({ ...routed.value.state, queued: false });
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
              ? routeChild(hub, target, intervention, inputSequence)
              : routeParent(hub, intervention, inputSequence)
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
            queued: applied.success.queued,
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

  const attached = Effect.fn("AttemptRuntime.attached")(
    function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const relayed = Option.exists(hubs.find(attemptId), ({ channel }) => Option.isSome(channel));
      if (!relayed) {
        yield* Effect.logDebug("Waiting for an execute call to relay the Attempt's channel");
      }
      yield* hubs.attached(attemptId);
      if (!relayed) yield* Effect.logDebug("The Attempt's channel is relayed in this process");
    },
    (effect, attemptId) => effect.pipe(Effect.annotateLogs({ attemptId })),
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

  const notify = Effect.fn("AttemptRuntime.notify")(
    function* (attemptId: AttemptId, notice: AttemptChannel.WorkerNotice) {
      yield* Effect.annotateCurrentSpan({ attemptId, notice: notice._tag });
      const routed = yield* hubs.notice(attemptId, notice);
      if (routed._tag === "Kept")
        yield* Effect.logDebug(
          "Kept a Worker notice for an Attempt not tracked here yet; it is relayed after the parent starts",
          {
            notice: notice._tag,
            worker: notice.worker,
            kept: routed.kept.map(({ _tag }) => _tag),
          },
        );
    },
    (effect, attemptId) => effect.pipe(Effect.annotateLogs({ attemptId })),
  );

  yield* Effect.logInfo("The durable Attempt runtime is ready");
  return AttemptRuntime.of({
    execute,
    isLive,
    finished,
    recordResult,
    recordUnsupervised,
    unsupervised,
    request,
    intervene,
    attached,
    cancel,
    notify,
  });
});

/**
 * Provides `AttemptRuntime` on the durable harness. Building it installs the usine extension and
 * resumes unfinished Attempts.
 */
export const layer = Layer.effect(AttemptRuntime, makeAttemptRuntime);
