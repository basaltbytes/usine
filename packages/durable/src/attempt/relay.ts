// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import type { JsonValue } from "@earendil-works/chord";
import {
  type Cursor,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Page,
  type TaskId,
  type TaskRecord,
  UsageDoc,
  UserEntry,
} from "@earendil-works/pi-durable";
import { ModelId } from "@usine/core/agent/brain";
import {
  type AgentSessionEvent,
  type ParentSession,
  SessionFinished,
  SessionStarted,
  SessionTokensUpdated,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, type AttemptFailure } from "@usine/core/attempt/failure";
import { StepResult } from "@usine/core/step/result";
import { DateTime, Deferred, Effect, Option, Queue, Result, Schema } from "effect";
import type { AttemptRequest } from "../attempt-runtime.ts";
import type { DurableHarness, DurableHarnessError } from "../harness.ts";
import { type AttemptRecord, AttemptRecordDoc, hasStarted, HoldDoc } from "./documents.ts";
import { entryEvents, ledgerUsage } from "./events.ts";
import {
  type AttemptHub,
  type AttemptHubs,
  type ChildDelivery,
  keepNotice,
  type RelayItem,
  type RelayProgress,
} from "./hubs.ts";
import { SubagentDoc } from "./child.ts";
import { settledOf } from "./outcome.ts";
import { childSessionId, parentSession, parentSessionId } from "./parent.ts";
import { queueParentSteer } from "./steering.ts";

const PAGE = 64;

/** The kind of the durable task that runs one tool call of the parent. */
const TOOL_TASK = "pi.tool";

const unavailable = () =>
  AgentFailure.make({ message: "This attempt no longer has a live channel" });

/** Returns `value` as an `EntryId`, where 0 sorts before every committed entry. */
const entryId = (value: number): EntryId =>
  // SAFETY: the value is 0 or an ID assigned by pi-durable and stored by this package.
  value as EntryId;

const entryQuery = (
  from: number,
  bound: Option.Option<EntryId>,
): Omit<EntryQuery, "conversationId"> =>
  Option.match(bound, {
    onNone: () => ({ minEntryId: entryId(from), order: "ascending" }),
    onSome: (max) => ({ minEntryId: entryId(from), maxEntryId: max, order: "ascending" }),
  });

const progressOf = (record: Readonly<AttemptRecord>): RelayProgress => {
  const nextSequence = record.nextOutbound - (record.pendingOutbound?.length ?? 0);
  return {
    outbound: {
      state:
        nextSequence === 1 ? "AwaitingStarted" : record.terminalRelayed ? "Terminal" : "Running",
      nextSequence,
    },
    inbound: record.nextInbound,
    entry: record.relayedEntry,
    tokens: record.relayedTokens,
  };
};

type RelayCursor = Pick<RelayProgress, "entry" | "tokens">;

const cursorOf = ({ entry, tokens }: RelayProgress): RelayCursor => ({ entry, tokens });

/** A started Attempt, with its parent session if it has one. */
interface StartedAttempt {
  readonly parent: Option.Option<ParentSession>;
}

/**
 * Reads the Attempt's durable record. Returns `undefined` before the first `execute` creates its
 * task.
 */
export const readRecord = (durable: DurableHarness["Service"], attemptId: string) =>
  durable.use("read the Attempt record", (harness, context) =>
    harness.snapshot(AttemptRecordDoc, attemptId, context),
  );

const outboundJson = Schema.fromJsonString(AttemptChannel.OutboundEnvelope);
const encodeOutbound = Schema.encodeEffect(outboundJson);
const decodeOutbound = Schema.decodeUnknownEffect(Schema.Array(outboundJson));

const admitOutbound = (
  hub: AttemptHub,
  progress: AttemptChannel.Progress,
  envelope: AttemptChannel.OutboundEnvelope,
) =>
  Effect.fromResult(AttemptChannel.admit(progress, hub.attemptId, envelope)).pipe(
    Effect.mapError((violation) => new Error(`${violation.message}: ${violation.detail}`)),
    Effect.orDie,
  );

/** Delivers the stored batch before clearing it. The caller must hold the emission permit. */
const flushPending = Effect.fn("AttemptRelay.flushPending")(function* (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: hub.attemptId, taskId: hub.taskId });
  if (Option.isNone(hub.channel)) return yield* unavailable();
  const { io, progress } = hub.channel.value;
  const record = yield* readRecord(durable, hub.attemptId);
  if (record === undefined) {
    return yield* Effect.die(new Error(`Attempt ${hub.attemptId} has no durable record`));
  }
  const pending = yield* decodeOutbound(record.pendingOutbound ?? []).pipe(Effect.orDie);
  if (pending.length === 0) return;
  let outbound = progressOf(record).outbound;
  for (const envelope of pending) {
    outbound = yield* admitOutbound(hub, outbound, envelope);
    yield* io.append("outbound", envelope).pipe(
      Effect.tapError((failure) =>
        Effect.logWarning("Outbound delivery failed; the batch remains pending", {
          attemptId: hub.attemptId,
          sequence: envelope.sequence,
          failure: failure._tag,
        }),
      ),
    );
  }
  yield* durable.use("clear the delivered envelopes", (harness, context) =>
    harness.commit(async (tx) => {
      const current = await tx.doc(AttemptRecordDoc, hub.attemptId, null);
      current.pendingOutbound = [];
      current.terminalRelayed = outbound.state === "Terminal";
    }, context),
  );
  progress.outbound = outbound;
  progress.entry = record.relayedEntry;
  progress.tokens = record.relayedTokens;
  yield* Effect.logDebug("Delivered the Attempt's outbound batch", {
    envelopes: pending.length,
    nextSequence: outbound.nextSequence,
    terminal: outbound.state === "Terminal",
  });
});

/** Reserves a batch and its cursor atomically, then delivers it from durable storage. */
const emit = (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
  payloads: ReadonlyArray<AttemptChannel.OutboundPayload>,
  advance: (progress: RelayProgress) => RelayCursor,
): Effect.Effect<void, AttemptFailure | DurableHarnessError> =>
  hub.emission.withPermits(1)(
    Effect.gen(function* () {
      yield* flushPending(durable, hub);
      if (Option.isNone(hub.channel)) return yield* unavailable();
      const { progress } = hub.channel.value;
      const pending: Array<string> = [];
      let outbound = progress.outbound;
      for (const payload of payloads) {
        const envelope = AttemptChannel.OutboundEnvelope.make({
          version: AttemptChannel.PROTOCOL_VERSION,
          attemptId: hub.attemptId,
          sequence: AttemptChannel.Sequence.make(outbound.nextSequence),
          sentAt: yield* DateTime.now,
          payload,
        });
        outbound = yield* admitOutbound(hub, outbound, envelope);
        const encoded = yield* encodeOutbound(envelope).pipe(Effect.orDie);
        pending.push(encoded);
      }
      const cursor = advance(progress);
      yield* durable.use("reserve the outbound envelopes", (harness, context) =>
        harness.commit(async (tx) => {
          const record = await tx.doc(AttemptRecordDoc, hub.attemptId, null);
          record.pendingOutbound = pending;
          record.nextOutbound = outbound.nextSequence;
          record.relayedEntry = cursor.entry;
          record.relayedTokens = cursor.tokens;
        }, context),
      );
      yield* flushPending(durable, hub);
    }),
  );

/** Sends a payload that is not derived from a parent entry, such as an intervention result. */
export const emitPayload = (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
  payload: AttemptChannel.OutboundPayload,
) => emit(durable, hub, [payload], cursorOf);

/** Appends an operator input to the transcript and returns its inbound sequence number. */
export const appendInbound = (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
  operator: string,
  target: AttemptChannel.SessionTarget,
  payload: AttemptChannel.InboundPayload,
): Effect.Effect<AttemptChannel.Sequence, AttemptFailure | DurableHarnessError> =>
  hub.emission.withPermits(1)(
    Effect.gen(function* () {
      if (Option.isNone(hub.channel)) return yield* unavailable();
      const { io, progress } = hub.channel.value;

      const envelope = AttemptChannel.InboundEnvelope.make({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId: hub.attemptId,
        sequence: AttemptChannel.Sequence.make(progress.inbound),
        sentAt: yield* DateTime.now,
        target,
        operator,
        payload,
      });
      yield* io.append("inbound", envelope);
      yield* durable.use("record the inbound envelope", (harness, context) =>
        harness.commit(async (tx) => {
          const record = await tx.doc(AttemptRecordDoc, hub.attemptId, null);
          record.nextInbound = envelope.sequence + 1;
        }, context),
      );
      progress.inbound = envelope.sequence + 1;
      return envelope.sequence;
    }),
  );

const decodeIntervention = Schema.decodeUnknownEffect(AttemptChannel.Intervention);

/**
 * Returns the parent's supervision state after it read an input. A retired Hold counts as not
 * paused and not held.
 */
const deliveredState = (durable: DurableHarness["Service"], hub: AttemptHub) =>
  Effect.map(
    durable.use("read the Hold", (harness, context) =>
      harness.snapshot(HoldDoc, hub.taskId, context),
    ),
    (hold) =>
      AttemptChannel.InterventionState.make({
        held: hold?.held.includes(parentSessionId(hub.attemptId)) ?? false,
        paused: hold?.paused ?? false,
      }),
  );

/** Removes an operator input from `queuedInputs`. */
const forgetQueuedInput = (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
  inputSequence: number,
) =>
  durable.use("forget the delivered operator input", (harness, context) =>
    harness.commit(async (tx) => {
      const record = await tx.doc(AttemptRecordDoc, hub.attemptId, null);
      record.queuedInputs = (record.queuedInputs ?? []).filter(
        (queuedInput) => queuedInput.inputSequence !== inputSequence,
      );
    }, context),
  );

/** Sends the second receipt for an operator input that a child queued and never read. */
const childStoppedFirst = (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
  inputSequence: AttemptChannel.Sequence,
  intervention: AttemptChannel.Intervention,
) =>
  emitPayload(
    durable,
    hub,
    AttemptChannel.InterventionRejected.make({
      inputSequence,
      intervention,
      message: "The child stopped before it read this message. Send it again if it still applies.",
    }),
  );

const returnSteerToParent = Effect.fn("AttemptRelay.returnSteerToParent")(function* (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
  inputSequence: AttemptChannel.Sequence,
  intervention: AttemptChannel.Intervention,
) {
  if (intervention.target._tag !== "Parent" || intervention.action._tag !== "Steer") return false;
  yield* Effect.annotateCurrentSpan({ attemptId: hub.attemptId, inputSequence });
  const paused = yield* durable.use(
    "read the parent's pause state",
    async (harness, context) =>
      (await harness.snapshot(HoldDoc, hub.taskId, context))?.paused ?? false,
  );
  if (paused) {
    yield* Effect.logInfo("The parent was interrupted; its unread forwarded steer is withdrawn", {
      inputSequence,
    });
    return false;
  }
  const queued = yield* queueParentSteer(
    durable,
    hub,
    inputSequence,
    intervention.operator,
    intervention.action,
  );
  if (Option.isNone(queued)) return false;
  yield* emitPayload(
    durable,
    hub,
    AttemptChannel.InterventionApplied.make({ inputSequence, intervention, state: queued.value }),
  );
  return true;
});

/**
 * Returns the child sessions whose `subagent` calls have not returned. A replayed call restores its
 * child's queued inputs and settles them when it ends.
 */
const unfinishedChildren = Effect.fn("AttemptRelay.unfinishedChildren")(function* (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
) {
  if (Option.isNone(hub.parent)) return new Set<string>();
  const parent = hub.parent.value;
  const children = yield* durable.use(
    "read the unfinished child calls",
    async (harness, context) => {
      const tasks = await harness.commit(async (tx) => {
        const found: Array<TaskId> = [];
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanTasks(
            { conversationId: parent, kind: TOOL_TASK },
            PAGE,
            cursor,
          );
          for (const task of page.items)
            if (task.state.status !== "completing" && task.state.status !== "terminal")
              found.push(task.id);
          cursor = page.next;
        } while (cursor !== undefined);
        return found;
      }, context);
      const sessions = new Set<string>();
      for (const task of tasks) {
        const delegation = await harness.snapshot(SubagentDoc, task, context);
        if (delegation !== undefined && delegation.count !== null)
          sessions.add(childSessionId(hub.attemptId, delegation.count));
      }
      return sessions;
    },
  );
  yield* Effect.logDebug("Read the children whose calls have not returned", {
    sessionIds: [...children],
  });
  return children;
});

/**
 * Sends the second receipt for each resolved queued operator input, and rejects all unread ones if
 * `attempt` is `ended`. The caller must hold the hub's routing permit.
 */
export const relayDeliveries = Effect.fn("AttemptRelay.deliveries")(function* (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
  attempt: "live" | "ended",
) {
  const queued = (yield* readRecord(durable, hub.attemptId))?.queuedInputs ?? [];
  const unfinished = yield* Effect.cached(unfinishedChildren(durable, hub));
  for (const input of queued) {
    if ("child" in input) {
      if (attempt === "live" && hub.childInputs.has(input.inputSequence)) {
        yield* Effect.logDebug("A queued operator input still waits for its child", {
          inputSequence: input.inputSequence,
          sessionId: input.child,
        });
        continue;
      }
      if (attempt === "live" && (yield* unfinished).has(input.child)) {
        yield* Effect.logDebug("A queued operator input waits for its child's replayed call", {
          inputSequence: input.inputSequence,
          sessionId: input.child,
        });
        continue;
      }
      hub.childInputs.delete(input.inputSequence);
      const intervention = yield* decodeIntervention(input.intervention).pipe(Effect.orDie);
      if (
        attempt === "live" &&
        (yield* returnSteerToParent(
          durable,
          hub,
          AttemptChannel.Sequence.make(input.inputSequence),
          intervention,
        ))
      )
        continue;
      yield* childStoppedFirst(
        durable,
        hub,
        AttemptChannel.Sequence.make(input.inputSequence),
        intervention,
      );
      yield* Effect.logWarning("The child stopped before it read a queued operator input", {
        inputSequence: input.inputSequence,
        sessionId: input.child,
        action: intervention.action._tag,
        attempt,
      });
      yield* forgetQueuedInput(durable, hub, input.inputSequence);
      continue;
    }
    const status = yield* durable.use("read a queued operator input", async (harness, context) => {
      if ("requestId" in input) {
        if (Option.isNone(hub.parent)) return undefined;
        const parent = hub.parent.value;
        return harness.commit(async (tx) => {
          const submission = await tx.submissionByRequest(parent, input.requestId);
          if (submission === undefined && (await tx.doc(HoldDoc, hub.taskId)).paused)
            return "withdrawn";
          return submission?.status;
        }, context);
      }
      const submission = await harness.submission(input.submission, context);
      return submission === undefined ? undefined : (await submission.status(context)).status;
    });
    if (
      (status === "queued" || (status === undefined && "requestId" in input)) &&
      attempt === "live"
    ) {
      yield* Effect.logDebug("A queued operator input still waits for the parent", {
        inputSequence: input.inputSequence,
      });
      continue;
    }
    const intervention = yield* decodeIntervention(input.intervention).pipe(Effect.orDie);
    const inputSequence = AttemptChannel.Sequence.make(input.inputSequence);
    if (status === "placed" || status === "done") {
      yield* emitPayload(
        durable,
        hub,
        AttemptChannel.InterventionApplied.make({
          inputSequence,
          intervention,
          state: yield* deliveredState(durable, hub),
        }),
      );
      yield* Effect.logInfo("The parent read a queued operator input", {
        inputSequence,
        action: intervention.action._tag,
      });
    } else {
      yield* emitPayload(
        durable,
        hub,
        AttemptChannel.InterventionRejected.make({
          inputSequence,
          intervention,
          message:
            "The parent stopped before it read this message. Send it again if it still applies.",
        }),
      );
      yield* Effect.logWarning("The parent stopped before it read a queued operator input", {
        inputSequence,
        action: intervention.action._tag,
        submissionStatus: status ?? "missing",
      });
    }
    yield* forgetQueuedInput(durable, hub, input.inputSequence);
  }
});

/**
 * Sends the second receipt for a child-queued operator input when the child reports it, unless it
 * was already sent. The caller must hold the hub's routing permit.
 */
const relayChildDelivery = Effect.fn("AttemptRelay.childDelivery")(function* (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
  delivery: ChildDelivery,
) {
  const { inputSequence, intervention } = delivery;
  hub.childInputs.delete(inputSequence);
  const queued = (yield* readRecord(durable, hub.attemptId))?.queuedInputs ?? [];
  if (!queued.some((input) => input.inputSequence === inputSequence)) {
    return yield* Effect.logDebug("A child reported an operator input already settled", {
      inputSequence,
    });
  }
  const fields = {
    inputSequence,
    action: intervention.action._tag,
    sessionId: intervention.target._tag === "Child" ? intervention.target.sessionId : "parent",
  };
  if (Option.isSome(delivery.delivered)) {
    yield* emitPayload(
      durable,
      hub,
      AttemptChannel.InterventionApplied.make({
        inputSequence,
        intervention,
        state: delivery.delivered.value,
      }),
    );
    yield* Effect.logInfo("The child read a queued operator input", fields);
  } else {
    if (yield* returnSteerToParent(durable, hub, inputSequence, intervention)) return;
    yield* childStoppedFirst(durable, hub, inputSequence, intervention);
    yield* Effect.logWarning("The child stopped before it read a queued operator input", fields);
  }
  yield* forgetQueuedInput(durable, hub, inputSequence);
});

/**
 * Relays one Attempt to `io` in order of occurrence until exactly one terminal envelope (`Final`,
 * `Failed`, or `Interrupted`) is sent. Continues from the durable progress of an earlier call.
 */
export const relayAttempt = Effect.fn("AttemptRelay.relay")(function* (
  durable: DurableHarness["Service"],
  hubs: AttemptHubs,
  hub: AttemptHub,
  request: AttemptRequest,
  io: AttemptChannel.Sink,
) {
  const spec = request.spec;
  yield* Effect.annotateCurrentSpan({ attemptId: hub.attemptId, taskId: hub.taskId });
  const loaded = yield* readRecord(durable, hub.attemptId);
  if (loaded === undefined) {
    return yield* Effect.die(new Error(`Attempt ${hub.attemptId} has no durable record`));
  }
  const readTask = durable.use("read the Attempt task", (harness, context) =>
    harness.getTask(hub.taskId, context),
  );
  const attached = yield* Effect.acquireRelease(
    Effect.sync(() => {
      if (Option.isSome(hub.channel)) return false;
      hub.channel = Option.some({ io, progress: progressOf(loaded) });
      Deferred.doneUnsafe(hub.attached, Effect.succeed(request));
      return true;
    }),
    (attachedHere) =>
      attachedHere
        ? Effect.sync(() => {
            hub.channel = Option.none();
            hub.attached = Deferred.makeUnsafe();
          }).pipe(Effect.tap(() => Effect.logDebug("Detached the Attempt's channel")))
        : Effect.void,
  );
  if (!attached) {
    yield* Effect.logWarning(
      "Another execute call is relaying this Attempt; waiting for its outcome",
    );
    const task = yield* durable.use("wait for the Attempt task", (harness, context) =>
      harness.waitForTask(hub.taskId, context),
    );
    return settledOf(task);
  }
  yield* Effect.logInfo("Relaying the Attempt's channel", {
    nextSequence: loaded.nextOutbound,
    relayedEntry: loaded.relayedEntry,
  });
  const progress = (): RelayProgress =>
    Option.match(hub.channel, {
      onNone: () => progressOf(loaded),
      onSome: (channel) => channel.progress,
    });
  if ((loaded.pendingOutbound?.length ?? 0) > 0) {
    yield* Effect.logInfo("Replaying the Attempt's pending outbound envelopes", {
      envelopes: loaded.pendingOutbound?.length,
      nextSequence: progress().outbound.nextSequence,
    });
  }
  yield* hub.emission.withPermits(1)(flushPending(durable, hub));
  if (progress().outbound.state === "Terminal") {
    const task = yield* readTask;
    if (task === undefined) {
      return yield* Effect.die(new Error(`Attempt task ${hub.taskId} is missing`));
    }
    yield* Effect.logInfo("The Attempt's terminal envelope was relayed");
    return settledOf(task);
  }
  const startedOf = (record: Readonly<AttemptRecord>): Option.Option<StartedAttempt> =>
    hasStarted(record)
      ? Option.some({
          parent: Option.map(Option.fromNullishOr(record.parentModel), (model) =>
            parentSession(spec, ModelId.make(model), record),
          ),
        })
      : Option.none();
  let start = startedOf(loaded);
  if (loaded.parentConversation !== null) hubs.bindParent(hub, loaded.parentConversation);

  /** Sends `Started`, and the parent's `SessionStarted` if it has one, once the task started. */
  const startAttempt = Effect.gen(function* () {
    if (Option.isSome(start) && progress().outbound.state !== "AwaitingStarted") return start;
    const record = yield* readRecord(durable, hub.attemptId);
    if (record === undefined) return Option.none<StartedAttempt>();
    const started = startedOf(record);
    if (Option.isNone(started)) return started;
    if (record.parentConversation !== null) hubs.bindParent(hub, record.parentConversation);
    start = started;
    const { parent } = started.value;
    if (progress().outbound.state === "AwaitingStarted") {
      yield* emitPayload(
        durable,
        hub,
        AttemptChannel.Started.make({
          parentModel: Option.map(parent, (session) => session.brain.model),
          conflictingSalvage: spec.conflictingSalvage,
        }),
      );
      if (Option.isSome(parent)) {
        yield* emitPayload(
          durable,
          hub,
          AttemptChannel.SessionEvent.make({
            event: SessionStarted.make({ session: parent.value }),
          }),
        );
      }
      yield* Effect.logInfo("Relayed the Attempt's start", {
        parentModel: Option.match(parent, {
          onNone: () => "none",
          onSome: (session) => session.brain.model,
        }),
      });
    }
    return start;
  });

  const relayEarlyNotices = Effect.gen(function* () {
    const early = hub.early;
    if (early.length === 0) return;
    hub.early = [];
    yield* emit(durable, hub, early, cursorOf);
    yield* Effect.logInfo("Relayed the Worker notices that arrived before the Attempt started", {
      notices: early.map(({ _tag }) => _tag),
    });
  });

  /** Starts the Attempt and, if it started, relays the early Worker notices. */
  const ensureStarted = Effect.gen(function* () {
    const started = yield* startAttempt;
    if (Option.isSome(started)) yield* relayEarlyNotices;
    return started;
  });

  const relayTokens = Effect.fn("AttemptRelay.tokens")(function* (started: ParentSession) {
    if (Option.isNone(hub.parent)) return;
    const parent = hub.parent.value;
    const usage = yield* durable.use("read the parent's usage", (harness, context) =>
      harness.snapshot(UsageDoc, parent, context),
    );
    const total = ledgerUsage(usage);
    if (total.totalTokens <= progress().tokens) return;
    yield* emit(
      durable,
      hub,
      [
        AttemptChannel.SessionEvent.make({
          event: SessionTokensUpdated.make({ session: started, ...total }),
        }),
      ],
      (current) => ({ ...cursorOf(current), tokens: total.totalTokens }),
    );
  });

  const deliveries = (attempt: "live" | "ended") =>
    hub.routing.withPermits(1)(relayDeliveries(durable, hub, attempt));
  const childDelivery = (delivery: ChildDelivery) =>
    hub.routing.withPermits(1)(relayChildDelivery(durable, hub, delivery));

  const relayEntries = Effect.fn("AttemptRelay.entries")(function* (bound: Option.Option<EntryId>) {
    const started = yield* ensureStarted;
    const session = Option.flatMap(started, ({ parent }) => parent);
    if (Option.isNone(session) || Option.isNone(hub.parent)) return;
    const parent = hub.parent.value;
    let placedInput = false;
    let next = Option.none<Cursor>();
    do {
      const query = entryQuery(progress().entry + 1, bound);
      const cursor = Option.getOrUndefined(next);
      const found = yield* durable.use(
        "read the parent's entries",
        async (harness, context): Promise<Page<EntryRecord, Cursor>> => {
          const conversation = await harness.conversation(parent, context);
          return conversation === undefined
            ? { items: [] }
            : conversation.entries(query, PAGE, cursor, context);
        },
      );
      for (const entry of found.items) {
        if (entry.kind === UserEntry.kind) placedInput = true;
        const events = entryEvents(entry, session.value);
        if (events.length === 0) {
          progress().entry = entry.id;
          continue;
        }
        yield* emit(
          durable,
          hub,
          events.map((event) => AttemptChannel.SessionEvent.make({ event })),
          (latest) => ({ ...cursorOf(latest), entry: entry.id }),
        );
      }
      next = Option.fromNullishOr(found.next);
    } while (Option.isSome(next));
    yield* relayTokens(session.value);
    if (placedInput) yield* deliveries("live");
  });

  const relayEvent = Effect.fn("AttemptRelay.event")(function* (event: AgentSessionEvent) {
    const started = yield* ensureStarted;
    if (Option.isNone(started)) {
      return yield* Effect.logWarning(
        "Dropped a session event that arrived before the Attempt started",
        {
          event: event._tag,
        },
      );
    }
    yield* emitPayload(durable, hub, AttemptChannel.SessionEvent.make({ event }));
  });

  const relayNotice = Effect.fn("AttemptRelay.notice")(function* (
    notice: AttemptChannel.WorkerNotice,
  ) {
    const started = yield* ensureStarted;
    if (Option.isNone(started)) {
      hub.early = keepNotice(hub.early, notice);
      return yield* Effect.logDebug("Kept a Worker notice until the Attempt starts", {
        notice: notice._tag,
        worker: notice.worker,
        kept: hub.early.map(({ _tag }) => _tag),
      });
    }
    yield* emitPayload(durable, hub, notice);
    yield* Effect.logDebug("Relayed a Worker notice", {
      notice: notice._tag,
      worker: notice.worker,
    });
  });

  const finish = Effect.fn("AttemptRelay.finish")(function* (
    task: TaskRecord<JsonValue, JsonValue, unknown>,
  ) {
    const settled = settledOf(task);
    const started = yield* ensureStarted;
    if (Option.isNone(started) && hub.early.length > 0) {
      yield* Effect.logWarning(
        "Dropped the Worker notices kept for an Attempt that never started",
        {
          notices: hub.early.map(({ _tag }) => _tag),
        },
      );
      hub.early = [];
    }
    yield* deliveries("ended");
    if (Result.isSuccess(settled)) {
      const parent = Option.flatMap(started, (attempt) => attempt.parent);
      if (Option.isSome(parent)) {
        yield* emitPayload(
          durable,
          hub,
          AttemptChannel.SessionEvent.make({
            event: SessionFinished.make({ session: parent.value }),
          }),
        );
      }
      yield* emitPayload(
        durable,
        hub,
        AttemptChannel.Final.make({
          result: StepResult.make({ message: settled.success.message, facts: [] }),
        }),
      );
    } else if (task.state.outcome?.status === "aborted" && Option.isSome(started)) {
      yield* emitPayload(durable, hub, AttemptChannel.Interrupted.make());
    } else {
      yield* emitPayload(durable, hub, AttemptChannel.Failed.make({ failure: settled.failure }));
    }
    yield* Effect.logInfo("Relayed the Attempt's terminal envelope", {
      outcome: task.state.outcome?.status,
    });
    return settled;
  });

  const pending: Array<RelayItem> = yield* Queue.clear(hub.queue);
  const firstEntry = pending.find((item) => item._tag === "Entry");
  yield* relayEntries(
    firstEntry?._tag === "Entry" ? Option.some(entryId(firstEntry.entry - 1)) : Option.none(),
  );
  yield* deliveries("live");
  pending.push({ _tag: "Wake" });

  const take = Effect.suspend(() => {
    const item = pending.shift();
    return item === undefined ? Queue.take(hub.queue) : Effect.succeed(item);
  });

  while (true) {
    const item = yield* take;
    if (item._tag === "Entry") {
      yield* relayEntries(Option.some(item.entry));
    } else if (item._tag === "Event") {
      yield* relayEvent(item.event);
    } else if (item._tag === "Notice") {
      yield* relayNotice(item.notice);
    } else if (item._tag === "Delivery") {
      yield* childDelivery(item);
    } else {
      yield* ensureStarted;
      const task = yield* readTask;
      if (task === undefined) {
        return yield* Effect.die(new Error(`Attempt task ${hub.taskId} is missing`));
      }
      if (task.state.status !== "terminal") continue;
      const rest = [...pending.splice(0), ...(yield* Queue.clear(hub.queue))];
      for (const remaining of rest) {
        if (remaining._tag === "Entry") yield* relayEntries(Option.some(remaining.entry));
        else if (remaining._tag === "Event") yield* relayEvent(remaining.event);
        else if (remaining._tag === "Notice") yield* relayNotice(remaining.notice);
        else if (remaining._tag === "Delivery") yield* childDelivery(remaining);
      }
      yield* relayEntries(Option.none());
      return yield* finish(task);
    }
  }
}, Effect.scoped);
