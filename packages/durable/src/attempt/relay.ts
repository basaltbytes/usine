import type { JsonValue } from "@earendil-works/chord";
import {
  type Cursor,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Page,
  type TaskRecord,
  UsageDoc,
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
import { DateTime, Deferred, Effect, Option, Queue, Result } from "effect";
import type { AttemptRequest } from "../attempt-runtime.ts";
import type { DurableHarness, DurableHarnessError } from "../harness.ts";
import { type AttemptRecord, AttemptRecordDoc } from "./documents.ts";
import { entryEvents, usageTokens } from "./events.ts";
import type { AttemptHub, AttemptHubs, RelayItem, RelayProgress } from "./hubs.ts";
import { settledOf } from "./outcome.ts";
import { parentSession } from "./parent.ts";

const PAGE = 64;

const unavailable = () =>
  new AgentFailure({ message: "This Attempt no longer has a live channel" });

/** pi-durable entry ids are plain numbers; 0 sorts before every committed entry. */
const entryId = (value: number): EntryId =>
  // SAFETY: the value is either 0 or an id pi-durable assigned and this package stored.
  value as EntryId;

const entryQuery = (
  from: number,
  bound: Option.Option<EntryId>,
): Omit<EntryQuery, "conversationId"> =>
  Option.match(bound, {
    onNone: () => ({ minEntryId: entryId(from), order: "ascending" }),
    onSome: (max) => ({ minEntryId: entryId(from), maxEntryId: max, order: "ascending" }),
  });

const progressOf = (record: Readonly<AttemptRecord>): RelayProgress => ({
  outbound: {
    state:
      record.nextOutbound === 1
        ? "AwaitingStarted"
        : record.terminalRelayed
          ? "Terminal"
          : "Running",
    nextSequence: record.nextOutbound,
  },
  inbound: record.nextInbound,
  entry: record.relayedEntry,
  parts: record.relayedParts,
  tokens: record.relayedTokens,
});

interface RelayCursor {
  readonly entry: number;
  readonly parts: number;
  readonly tokens: number;
}

const cursorOf = (progress: RelayProgress): RelayCursor => ({
  entry: progress.entry,
  parts: progress.parts,
  tokens: progress.tokens,
});

/** Reads one Attempt's durable record; absent until `execute` first creates its task. */
export const readRecord = (durable: DurableHarness["Service"], attemptId: string) =>
  durable.use("read the Attempt record", (harness, context) =>
    harness.snapshot(AttemptRecordDoc, attemptId, context),
  );

/**
 * Sends one outbound envelope with the next sequence and records the new
 * progress in the Attempt's record. The append comes first: a crash between
 * the two resends the same sequence, which the transcript keeps once, instead
 * of leaving a gap `admit` would reject.
 */
const emit = (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
  payload: AttemptChannel.OutboundPayload,
  advance: (progress: RelayProgress) => RelayCursor,
): Effect.Effect<void, AttemptFailure | DurableHarnessError> =>
  hub.emission.withPermits(1)(
    Effect.gen(function* () {
      if (Option.isNone(hub.channel)) return yield* unavailable();
      const { io, progress } = hub.channel.value;
      const envelope = new AttemptChannel.OutboundEnvelope({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId: hub.attemptId,
        sequence: AttemptChannel.Sequence.make(progress.outbound.nextSequence),
        sentAt: yield* DateTime.now,
        payload,
      });
      const admitted = AttemptChannel.admit(progress.outbound, hub.attemptId, envelope);
      if (Result.isFailure(admitted)) {
        return yield* Effect.die(
          new Error(`${admitted.failure.message}: ${admitted.failure.detail}`),
        );
      }
      const cursor = advance(progress);
      yield* io.append("outbound", envelope);
      yield* durable.use("record the relayed envelope", (harness, context) =>
        harness.commit(async (tx) => {
          const record = await tx.doc(AttemptRecordDoc, hub.attemptId, null);
          record.nextOutbound = admitted.success.nextSequence;
          record.relayedEntry = cursor.entry;
          record.relayedParts = cursor.parts;
          record.relayedTokens = cursor.tokens;
          record.terminalRelayed = admitted.success.state === "Terminal";
        }, context),
      );
      progress.outbound = admitted.success;
      progress.entry = cursor.entry;
      progress.parts = cursor.parts;
      progress.tokens = cursor.tokens;
    }),
  );

/** Sends one payload that is not derived from a parent entry, such as an intervention result. */
export const emitPayload = (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
  payload: AttemptChannel.OutboundPayload,
) => emit(durable, hub, payload, cursorOf);

/** Records one operator input in the transcript with the next inbound sequence, and returns that sequence. */
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
      const envelope = new AttemptChannel.InboundEnvelope({
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

/**
 * Relays one Attempt to `io` until its terminal envelope is sent: `Started`,
 * the parent's committed entries and the children's events in the order they
 * happened, then exactly one `Final`, `Failed`, or `Interrupted`. Progress is
 * durable, so a later call continues the same sequence.
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
  if (loaded.terminalRelayed) {
    const task = yield* readTask;
    if (task === undefined) {
      return yield* Effect.die(new Error(`Attempt task ${hub.taskId} is missing`));
    }
    yield* Effect.logInfo("The Attempt's terminal envelope was already relayed");
    return settledOf(task);
  }
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
  let session = Option.map(Option.fromNullishOr(loaded.parentModel), (model) =>
    parentSession(spec, ModelId.make(model)),
  );
  hub.session = session;
  if (loaded.parentConversation !== null) hubs.bindParent(hub, loaded.parentConversation);

  const ensureStarted = Effect.gen(function* () {
    if (Option.isSome(session) && progress().outbound.state !== "AwaitingStarted") {
      return session;
    }
    const record = yield* readRecord(durable, hub.attemptId);
    if (record === undefined || record.parentModel === null) {
      return Option.none<ParentSession>();
    }
    if (record.parentConversation !== null) hubs.bindParent(hub, record.parentConversation);
    const started = parentSession(spec, ModelId.make(record.parentModel));
    session = Option.some(started);
    hub.session = session;
    if (progress().outbound.state === "AwaitingStarted") {
      yield* emitPayload(
        durable,
        hub,
        new AttemptChannel.Started({ parentModel: started.brain.model }),
      );
      yield* emitPayload(
        durable,
        hub,
        new AttemptChannel.SessionEvent({ event: new SessionStarted({ session: started }) }),
      );
      yield* Effect.logInfo("Relayed the Attempt's start", { parentModel: started.brain.model });
    }
    return session;
  });

  const relayTokens = Effect.fn("AttemptRelay.tokens")(function* (started: ParentSession) {
    if (Option.isNone(hub.parent)) return;
    const parent = hub.parent.value;
    const usage = yield* durable.use("read the parent's usage", (harness, context) =>
      harness.snapshot(UsageDoc, parent, context),
    );
    const total = usageTokens(usage);
    if (total <= progress().tokens) return;
    yield* emit(
      durable,
      hub,
      new AttemptChannel.SessionEvent({
        event: new SessionTokensUpdated({ session: started, totalTokens: total }),
      }),
      (current) => ({ ...cursorOf(current), tokens: total }),
    );
  });

  const relayEntries = Effect.fn("AttemptRelay.entries")(function* (bound: Option.Option<EntryId>) {
    const started = yield* ensureStarted;
    if (Option.isNone(started) || Option.isNone(hub.parent)) return;
    const parent = hub.parent.value;
    let next = Option.none<Cursor>();
    do {
      const query = entryQuery(progress().entry, bound);
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
        const events = entryEvents(entry, started.value);
        const current = progress();
        const skip = entry.id === current.entry ? current.parts : 0;
        for (let part = skip; part < events.length; part += 1) {
          const event = events[part];
          if (event === undefined) continue;
          yield* emit(durable, hub, new AttemptChannel.SessionEvent({ event }), (latest) => ({
            ...cursorOf(latest),
            entry: entry.id,
            parts: part + 1,
          }));
        }
        const latest = progress();
        latest.entry = entry.id;
        latest.parts = events.length;
      }
      next = Option.fromNullishOr(found.next);
    } while (Option.isSome(next));
    yield* relayTokens(started.value);
  });

  const relayChild = Effect.fn("AttemptRelay.child")(function* (event: AgentSessionEvent) {
    const started = yield* ensureStarted;
    if (Option.isNone(started)) {
      return yield* Effect.logWarning(
        "Dropped a child event that arrived before the parent started",
        {
          event: event._tag,
        },
      );
    }
    yield* emitPayload(durable, hub, new AttemptChannel.SessionEvent({ event }));
  });

  const finish = Effect.fn("AttemptRelay.finish")(function* (
    task: TaskRecord<JsonValue, JsonValue, unknown>,
  ) {
    const settled = settledOf(task);
    const started = yield* ensureStarted;
    if (Result.isSuccess(settled)) {
      if (Option.isSome(started)) {
        yield* emitPayload(
          durable,
          hub,
          new AttemptChannel.SessionEvent({
            event: new SessionFinished({ session: started.value }),
          }),
        );
      }
      yield* emitPayload(
        durable,
        hub,
        new AttemptChannel.Final({
          result: new StepResult({ message: settled.success.message, facts: [] }),
        }),
      );
    } else if (task.state.outcome?.status === "aborted" && Option.isSome(started)) {
      yield* emitPayload(durable, hub, new AttemptChannel.Interrupted());
    } else {
      yield* emitPayload(durable, hub, new AttemptChannel.Failed({ failure: settled.failure }));
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
  pending.push({ _tag: "Wake" });

  const take = Effect.suspend(() => {
    const item = pending.shift();
    return item === undefined ? Queue.take(hub.queue) : Effect.succeed(item);
  });

  while (true) {
    const item = yield* take;
    if (item._tag === "Entry") {
      yield* relayEntries(Option.some(item.entry));
    } else if (item._tag === "Child") {
      yield* relayChild(item.event);
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
        else if (remaining._tag === "Child") yield* relayChild(remaining.event);
      }
      yield* relayEntries(Option.none());
      return yield* finish(task);
    }
  }
}, Effect.scoped);
