import { AgentSessionId, type ChildSessionCount } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { StepCompletion } from "@usine/core/step/result";
import { getTableName } from "drizzle-orm";
import { Duration, Effect, Layer, Option, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";

import { StoredRequest } from "../../attempt-runtime.ts";
import { JournalError } from "../../attempt/journal-error.ts";
import {
  AttemptJournal,
  ChildProgress,
  CoordinationStatus,
  CoordinatorSnapshot,
  Delegation,
  DelegationRecord,
  EncodedDecision,
  EncodedEvent,
  EncodedIntervention,
  EncodedState,
  EventSequence,
  JournalRevision,
  LedgerEntry,
  QueuedInput,
  Supervision,
} from "../journal.ts";
import {
  decided,
  keptDecision,
  keptDelegationOutcome,
  opened,
  progressed,
  reserved,
  settled,
  settledDelegation,
  startedDelegation,
  transitioned,
} from "../ledger.ts";
import { migrations } from "./migrations.ts";
import {
  coordinationTable,
  delegationsTable,
  eventsTable,
  inputsTable,
  outboxTable,
  supervisionTable,
} from "./schema.ts";

const json = <S extends Schema.Top>(schema: S) => Schema.fromJsonString(Schema.toCodecJson(schema));

const RequestJson = json(StoredRequest);
const StateJson = json(EncodedState);
const StatusJson = json(CoordinationStatus);
const EventJson = json(EncodedEvent);
const DecisionJson = json(EncodedDecision);
const DelegationJson = json(Delegation);
const ProgressJson = json(ChildProgress);
const EnvelopeJson = json(AttemptChannel.OutboundEnvelope);
const ResultJson = json(StepCompletion);
const InterventionJson = json(EncodedIntervention);

const CoordinationRow = Schema.Struct({
  request: RequestJson,
  revision: JournalRevision,
  state: Schema.NullOr(StateJson),
  status: StatusJson,
  nextOutbound: AttemptChannel.Sequence,
  result: Schema.NullOr(ResultJson),
  unsupervisedMillis: Schema.NullOr(Schema.Finite),
  nextInbound: AttemptChannel.Sequence,
});
const EventRow = Schema.Struct({
  sequence: EventSequence,
  event: Schema.NullOr(EventJson),
  decision: DecisionJson,
});
const DelegationRow = Schema.Struct({
  delegation: DelegationJson,
  progress: Schema.NullOr(ProgressJson),
  outcome: Schema.NullOr(EventJson),
});

const recordOf = ({ delegation, progress, outcome }: typeof DelegationRow.Type) =>
  DelegationRecord.make({
    ...delegation,
    progress: Option.fromNullOr(progress),
    outcome: Option.fromNullOr(outcome),
  });
const EnvelopeRow = Schema.Struct({ envelope: EnvelopeJson });
/** SQLite stores a boolean as 0 or 1. */
const StoredBoolean = Schema.Literals([0, 1]);
const SupervisionRow = Schema.Struct({
  sessionId: AgentSessionId,
  held: StoredBoolean,
  paused: StoredBoolean,
});
const InputRow = Schema.Struct({
  inputSequence: AttemptChannel.Sequence,
  sessionId: AgentSessionId,
  intervention: InterventionJson,
});

// Every value written was validated at construction, so an encoding failure is a defect.
const encode =
  <T>(codec: Schema.Codec<T, string>) =>
  (value: T) =>
    Schema.encodeEffect(codec)(value).pipe(Effect.orDie);

const coordination = getTableName(coordinationTable);
const events = getTableName(eventsTable);
const delegations = getTableName(delegationsTable);
const outbox = getTableName(outboxTable);
const supervision = getTableName(supervisionTable);
const inputs = getTableName(inputsTable);

/**
 * Provides the attempt journal on the application's `SqlClient`. Applies its embedded migrations
 * with their own `usine_attempt_journal_migrations` ledger, and runs each load and write in one
 * `BEGIN IMMEDIATE` transaction.
 */
export const sqliteAttemptJournalLayer = Layer.effect(
  AttemptJournal,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Migrator.make({})({
      table: "usine_attempt_journal_migrations",
      loader: Migrator.fromRecord(
        Object.fromEntries(
          migrations.map(([name, statements]) => [
            name,
            Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true }),
          ]),
        ),
      ),
    }).pipe(Effect.orDie);

    const failure = (operation: string, attemptId: AttemptId) => (cause: unknown) =>
      Effect.fail(JournalError.make({ operation, attemptId, cause }));
    const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        sql.withTransaction,
        Effect.provideService(SqlClient.BeginTransaction, "BEGIN IMMEDIATE"),
      );

    const load = (attemptId: AttemptId) =>
      Effect.gen(function* () {
        const [row] =
          yield* sql`SELECT request, revision, state, status, next_outbound AS "nextOutbound", result, unsupervised_millis AS "unsupervisedMillis", next_inbound AS "nextInbound" FROM ${sql(coordination)} WHERE attempt_id = ${attemptId}`;
        if (row === undefined) return Option.none<CoordinatorSnapshot>();
        const stored = yield* Schema.decodeUnknownEffect(CoordinationRow)(row);
        const ledger =
          yield* sql`SELECT sequence, event, decision FROM ${sql(events)} WHERE attempt_id = ${attemptId} ORDER BY sequence`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(EventRow))),
          );
        const children =
          yield* sql`SELECT delegation, progress, outcome FROM ${sql(delegations)} WHERE attempt_id = ${attemptId} ORDER BY number`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DelegationRow))),
          );
        const reservations =
          yield* sql`SELECT envelope FROM ${sql(outbox)} WHERE attempt_id = ${attemptId} ORDER BY sequence`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(EnvelopeRow))),
          );
        const supervised =
          yield* sql`SELECT session_id AS "sessionId", held, paused FROM ${sql(supervision)} WHERE attempt_id = ${attemptId} ORDER BY session_id`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SupervisionRow))),
          );
        const queued =
          yield* sql`SELECT sequence AS "inputSequence", session_id AS "sessionId", intervention FROM ${sql(inputs)} WHERE attempt_id = ${attemptId} ORDER BY sequence`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(InputRow))),
          );
        const applied = ledger.flatMap(({ sequence, event, decision }) =>
          event === null ? [] : [LedgerEntry.make({ sequence, event, decision })],
        );
        const pending = ledger.filter(({ event }) => event === null);
        return Option.some(
          CoordinatorSnapshot.make({
            request: stored.request,
            revision: stored.revision,
            state: Option.fromNullOr(stored.state),
            status: stored.status,
            events: applied,
            pendingDecision: Option.fromUndefinedOr(pending[0]).pipe(
              Option.map(({ decision }) => decision),
            ),
            delegations: children.map(recordOf),
            outbox: reservations.map(({ envelope }) => envelope),
            nextOutbound: stored.nextOutbound,
            result: Option.fromNullOr(stored.result),
            unsupervised: Option.map(Option.fromNullOr(stored.unsupervisedMillis), Duration.millis),
            supervision: supervised.map(({ sessionId, held, paused }) =>
              Supervision.make({ sessionId, held: held === 1, paused: paused === 1 }),
            ),
            inputs: queued.map((input) => QueuedInput.make(input)),
            nextInbound: stored.nextInbound,
          }),
        );
      });
    const existing = (attemptId: AttemptId) =>
      load(attemptId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die(new Error(`Attempt ${attemptId} has no journal`)),
            onSome: Effect.succeed,
          }),
        ),
      );
    const insertEnvelopes = (
      attemptId: AttemptId,
      envelopes: ReadonlyArray<AttemptChannel.OutboundEnvelope>,
    ) =>
      Effect.forEach(
        envelopes,
        (envelope) =>
          Effect.gen(function* () {
            const encoded = yield* encode(EnvelopeJson)(envelope);
            yield* sql`INSERT INTO ${sql(outbox)} ${sql.insert({ attempt_id: attemptId, sequence: envelope.sequence, envelope: encoded })}`;
          }),
        { discard: true },
      );
    const delegationRow = (attemptId: AttemptId, number: ChildSessionCount) =>
      Effect.gen(function* () {
        const [row] =
          yield* sql`SELECT delegation, progress, outcome FROM ${sql(delegations)} WHERE attempt_id = ${attemptId} AND number = ${number}`;
        if (row === undefined)
          return yield* Effect.die(new Error(`Attempt ${attemptId} has no delegation ${number}`));
        const decoded = yield* Schema.decodeUnknownEffect(DelegationRow)(row);
        return recordOf(decoded);
      });
    const updateProgress = (attemptId: AttemptId, record: DelegationRecord) =>
      Effect.gen(function* () {
        const progress = yield* Option.match(record.progress, {
          onNone: () => Effect.succeed(null),
          onSome: (value) => encode(ProgressJson)(value),
        });
        yield* sql`UPDATE ${sql(delegations)} SET progress = ${progress} WHERE attempt_id = ${attemptId} AND number = ${record.number}`;
      });
    const coordinationExists = (attemptId: AttemptId) =>
      Effect.gen(function* () {
        const [row] =
          yield* sql`SELECT unsupervised_millis AS "unsupervisedMillis" FROM ${sql(coordination)} WHERE attempt_id = ${attemptId}`;
        if (row === undefined)
          return yield* Effect.die(new Error(`Attempt ${attemptId} has no journal`));
        return yield* Schema.decodeUnknownEffect(
          Schema.Struct({ unsupervisedMillis: Schema.NullOr(Schema.Finite) }),
        )(row);
      });
    const updateCoordination = (snapshot: CoordinatorSnapshot) =>
      Effect.gen(function* () {
        const state = yield* Option.match(snapshot.state, {
          onNone: () => Effect.succeed(null),
          onSome: (value) => encode(StateJson)(value),
        });
        const status = yield* encode(StatusJson)(snapshot.status);
        yield* sql`UPDATE ${sql(coordination)} SET ${sql.update({ revision: snapshot.revision, state, status, next_outbound: snapshot.nextOutbound })} WHERE attempt_id = ${snapshot.attemptId}`;
      });

    return AttemptJournal.of({
      open: Effect.fn("AttemptJournal.open")(function* (request) {
        const attemptId = request.spec.attemptId;
        yield* Effect.annotateCurrentSpan({ attemptId });
        return yield* Effect.gen(function* () {
          const stored = yield* load(attemptId);
          if (Option.isSome(stored)) {
            yield* Effect.logInfo("Attempt journal already open; kept the first request", {
              attemptId,
            });
            return stored.value;
          }
          const snapshot = opened(request);
          const status = yield* encode(StatusJson)(snapshot.status);
          const encodedRequest = yield* encode(RequestJson)(request);
          yield* sql`INSERT INTO ${sql(coordination)} ${sql.insert({
            attempt_id: attemptId,
            request: encodedRequest,
            revision: snapshot.revision,
            state: null,
            status,
            next_outbound: snapshot.nextOutbound,
          })}`;
          yield* Effect.logInfo("Attempt journal opened", { attemptId });
          return snapshot;
        }).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("open the attempt journal", attemptId),
          ),
        );
      }),
      load: Effect.fn("AttemptJournal.load")(function* (attemptId) {
        yield* Effect.annotateCurrentSpan({ attemptId });
        // One transaction, so the four reads can't straddle a commit.
        return yield* load(attemptId).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("load the attempt journal", attemptId),
          ),
        );
      }),
      transition: Effect.fn("AttemptJournal.transition")(
        function* (attemptId, expected, step) {
          yield* Effect.annotateCurrentSpan({ attemptId, expectedRevision: expected });
          return yield* Effect.gen(function* () {
            const previous = yield* existing(attemptId);
            const next = yield* transitioned(previous, expected, step);
            const sequence = previous.nextEvent;
            const event = yield* encode(EventJson)(step.event);
            if (Option.isSome(previous.pendingDecision))
              yield* sql`UPDATE ${sql(events)} SET event = ${event} WHERE attempt_id = ${attemptId} AND sequence = ${sequence}`;
            else {
              const decision = yield* encode(DecisionJson)(step.decision);
              yield* sql`INSERT INTO ${sql(events)} ${sql.insert({ attempt_id: attemptId, sequence, event, decision })}`;
            }
            yield* updateCoordination(next);
            for (const intent of step.intents) {
              if (intent._tag !== "Delegate") continue;
              const delegation = yield* encode(DelegationJson)(intent.delegation);
              yield* sql`INSERT INTO ${sql(delegations)} ${sql.insert({ attempt_id: attemptId, number: intent.delegation.number, delegation, progress: null, outcome: null })}`;
            }
            yield* insertEnvelopes(attemptId, step.outbound);
            return next;
          }).pipe(
            transaction,
            Effect.catchTag(
              ["SqlError", "SchemaError"],
              failure("commit an attempt journal transition", attemptId),
            ),
          );
        },
        Effect.tap((snapshot) =>
          Effect.logInfo("Attempt journal transition committed", {
            attemptId: snapshot.attemptId,
            revision: snapshot.revision,
            event: snapshot.events.length,
          }),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("Attempt journal transition refused", {
            attemptId: error.attemptId,
            errorTag: error._tag,
          }),
        ),
      ),
      decide: Effect.fn("AttemptJournal.decide")(function* (attemptId, sequence, decision) {
        yield* Effect.annotateCurrentSpan({ attemptId, event: sequence });
        return yield* Effect.gen(function* () {
          const previous = yield* existing(attemptId);
          const result = yield* decided(previous, sequence, decision);
          if (result.snapshot !== previous) {
            const encoded = yield* encode(DecisionJson)(decision);
            yield* sql`INSERT INTO ${sql(events)} ${sql.insert({ attempt_id: attemptId, sequence, event: null, decision: encoded })}`;
          } else yield* keptDecision(previous, sequence, result.recorded, decision);
          return result.recorded;
        }).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("record an attempt decision", attemptId),
          ),
        );
      }),
      reserve: Effect.fn("AttemptJournal.reserve")(function* (attemptId, envelopes) {
        yield* Effect.annotateCurrentSpan({ attemptId, envelopes: envelopes.length });
        yield* Effect.gen(function* () {
          const previous = yield* existing(attemptId);
          const next = yield* reserved(previous, envelopes);
          yield* insertEnvelopes(attemptId, envelopes);
          yield* updateCoordination(next);
        }).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("reserve attempt envelopes", attemptId),
          ),
        );
      }),
      startDelegation: Effect.fn("AttemptJournal.startDelegation")(function* (attemptId, number) {
        yield* Effect.annotateCurrentSpan({ attemptId, delegation: number });
        return yield* Effect.gen(function* () {
          const previous = yield* delegationRow(attemptId, number);
          const result = startedDelegation(previous);
          if (result.record !== previous) yield* updateProgress(attemptId, result.record);
          return result.started;
        }).pipe(
          transaction,
          Effect.catchTag(["SqlError", "SchemaError"], failure("start a delegation", attemptId)),
        );
      }),
      saveProgress: Effect.fn("AttemptJournal.saveProgress")(function* (attemptId, number, change) {
        yield* Effect.annotateCurrentSpan({ attemptId, delegation: number, change: change._tag });
        yield* Effect.gen(function* () {
          const record = yield* delegationRow(attemptId, number).pipe(
            Effect.flatMap((current) => progressed(current, change)),
          );
          yield* updateProgress(attemptId, record);
        }).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("save a delegation's progress", attemptId),
          ),
        );
      }),
      settleDelegation: Effect.fn("AttemptJournal.settleDelegation")(
        function* (attemptId, number, outcome) {
          yield* Effect.annotateCurrentSpan({ attemptId, delegation: number });
          return yield* Effect.gen(function* () {
            const previous = yield* delegationRow(attemptId, number);
            const result = settledDelegation(previous, outcome);
            if (result.record !== previous) {
              const encoded = yield* encode(EventJson)(outcome);
              yield* sql`UPDATE ${sql(delegations)} SET outcome = ${encoded} WHERE attempt_id = ${attemptId} AND number = ${number}`;
            } else yield* keptDelegationOutcome(attemptId, number, result.recorded, outcome);
            return result.recorded;
          }).pipe(
            transaction,
            Effect.catchTag(
              ["SqlError", "SchemaError"],
              failure("record a delegation's outcome", attemptId),
            ),
          );
        },
      ),
      recordResult: Effect.fn("AttemptJournal.recordResult")(function* (attemptId, result) {
        yield* Effect.annotateCurrentSpan({ attemptId });
        yield* Effect.gen(function* () {
          yield* coordinationExists(attemptId);
          const encoded = yield* encode(ResultJson)(result);
          yield* sql`UPDATE ${sql(coordination)} SET result = ${encoded} WHERE attempt_id = ${attemptId}`;
        }).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("record the Attempt's result", attemptId),
          ),
        );
      }),
      recordUnsupervised: Effect.fn("AttemptJournal.recordUnsupervised")(
        function* (attemptId, unsupervised) {
          yield* Effect.annotateCurrentSpan({ attemptId });
          yield* Effect.gen(function* () {
            const { unsupervisedMillis } = yield* coordinationExists(attemptId);
            const millis = Math.max(unsupervisedMillis ?? 0, Duration.toMillis(unsupervised));
            yield* sql`UPDATE ${sql(coordination)} SET unsupervised_millis = ${millis} WHERE attempt_id = ${attemptId}`;
          }).pipe(
            transaction,
            Effect.catchTag(
              ["SqlError", "SchemaError"],
              failure("record the Attempt's unsupervised time", attemptId),
            ),
          );
        },
      ),
      supervise: Effect.fn("AttemptJournal.supervise")(function* (attemptId, change) {
        yield* Effect.annotateCurrentSpan({ attemptId, sessionId: change.sessionId });
        yield* Effect.gen(function* () {
          yield* coordinationExists(attemptId);
          yield* sql`DELETE FROM ${sql(supervision)} WHERE attempt_id = ${attemptId} AND session_id = ${change.sessionId}`;
          if (change.held || change.paused)
            yield* sql`INSERT INTO ${sql(supervision)} ${sql.insert({
              attempt_id: attemptId,
              session_id: change.sessionId,
              held: change.held ? 1 : 0,
              paused: change.paused ? 1 : 0,
            })}`;
        }).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("save the operator's supervision of a child", attemptId),
          ),
        );
      }),
      queueInput: Effect.fn("AttemptJournal.queueInput")(function* (attemptId, input) {
        yield* Effect.annotateCurrentSpan({ attemptId, inputSequence: input.inputSequence });
        yield* Effect.gen(function* () {
          yield* coordinationExists(attemptId);
          const intervention = yield* encode(InterventionJson)(input.intervention);
          yield* sql`DELETE FROM ${sql(inputs)} WHERE attempt_id = ${attemptId} AND sequence = ${input.inputSequence}`;
          yield* sql`INSERT INTO ${sql(inputs)} ${sql.insert({
            attempt_id: attemptId,
            sequence: input.inputSequence,
            session_id: input.sessionId,
            intervention,
          })}`;
        }).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("queue an operator input", attemptId),
          ),
        );
      }),
      forgetInput: Effect.fn("AttemptJournal.forgetInput")(
        function* (attemptId, inputSequence, receipts) {
          yield* Effect.annotateCurrentSpan({
            attemptId,
            inputSequence,
            receipts: receipts.length,
          });
          return yield* Effect.gen(function* () {
            if (receipts.length > 0) {
              const previous = yield* existing(attemptId);
              const next = yield* reserved(previous, receipts);
              yield* insertEnvelopes(attemptId, receipts);
              yield* updateCoordination(next);
            } else yield* coordinationExists(attemptId);
            const [row] =
              yield* sql`SELECT sequence FROM ${sql(inputs)} WHERE attempt_id = ${attemptId} AND sequence = ${inputSequence}`;
            if (row === undefined) return false;
            yield* sql`DELETE FROM ${sql(inputs)} WHERE attempt_id = ${attemptId} AND sequence = ${inputSequence}`;
            return true;
          }).pipe(
            transaction,
            Effect.catchTag(
              ["SqlError", "SchemaError"],
              failure("forget a queued operator input", attemptId),
            ),
          );
        },
      ),
      recordInbound: Effect.fn("AttemptJournal.recordInbound")(function* (attemptId, sequence) {
        yield* Effect.annotateCurrentSpan({ attemptId, inputSequence: sequence });
        yield* Effect.gen(function* () {
          yield* coordinationExists(attemptId);
          yield* sql`UPDATE ${sql(coordination)} SET next_inbound = MAX(next_inbound, ${sequence + 1}) WHERE attempt_id = ${attemptId}`;
        }).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("record an operator input", attemptId),
          ),
        );
      }),
      acknowledge: Effect.fn("AttemptJournal.acknowledge")(function* (attemptId, through) {
        yield* Effect.annotateCurrentSpan({ attemptId, through });
        yield* Effect.gen(function* () {
          yield* existing(attemptId);
          yield* sql`DELETE FROM ${sql(outbox)} WHERE attempt_id = ${attemptId} AND sequence <= ${through}`;
        }).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("acknowledge attempt envelopes", attemptId),
          ),
        );
      }),
      settle: Effect.fn("AttemptJournal.settle")(function* (attemptId) {
        yield* Effect.annotateCurrentSpan({ attemptId });
        yield* Effect.gen(function* () {
          const stored = yield* load(attemptId);
          if (Option.isNone(stored))
            return yield* Effect.logInfo("Skipped settling an Attempt that was never opened", {
              attemptId,
            });
          const next = settled(stored.value);
          if (Option.isNone(next))
            return yield* Effect.logInfo("Attempt journal already settled", { attemptId });
          yield* updateCoordination(next.value);
          yield* Effect.logInfo("Attempt journal settled", { attemptId });
        }).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("settle the attempt journal", attemptId),
          ),
        );
      }),
      settleOpen: Effect.fn("AttemptJournal.settleOpen")(function* (attemptId) {
        yield* Effect.annotateCurrentSpan({ attemptId });
        return yield* Effect.gen(function* () {
          const stored = yield* load(attemptId);
          if (Option.isNone(stored)) return Option.none();
          const { status } = stored.value;
          const next = settled(stored.value);
          if (status._tag === "Open" && Option.isSome(next)) {
            yield* updateCoordination(next.value);
            yield* Effect.logInfo("Open attempt journal settled", { attemptId });
          }
          return Option.some(status);
        }).pipe(
          transaction,
          Effect.catchTag(
            ["SqlError", "SchemaError"],
            failure("settle the open attempt journal", attemptId),
          ),
        );
      }),
    });
  }),
);
