import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { getTableName } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";

import { StoredRequest } from "../../attempt-runtime.ts";
import {
  AttemptJournal,
  CoordinationStatus,
  CoordinatorSnapshot,
  Delegation,
  EncodedDecision,
  EncodedEvent,
  EncodedState,
  EventSequence,
  JournalError,
  JournalRevision,
  LedgerEntry,
} from "../journal.ts";
import { decided, opened, reserved, settled, transitioned } from "../ledger.ts";
import { migrations } from "./migrations.ts";
import { coordinationTable, delegationsTable, eventsTable, outboxTable } from "./schema.ts";

const json = <S extends Schema.Top>(schema: S) => Schema.fromJsonString(Schema.toCodecJson(schema));

const RequestJson = json(StoredRequest);
const StateJson = json(EncodedState);
const StatusJson = json(CoordinationStatus);
const EventJson = json(EncodedEvent);
const DecisionJson = json(EncodedDecision);
const DelegationJson = json(Delegation);
const EnvelopeJson = json(AttemptChannel.OutboundEnvelope);

const CoordinationRow = Schema.Struct({
  request: RequestJson,
  revision: JournalRevision,
  state: Schema.NullOr(StateJson),
  status: StatusJson,
  nextOutbound: AttemptChannel.Sequence,
});
const EventRow = Schema.Struct({
  sequence: EventSequence,
  event: Schema.NullOr(EventJson),
  decision: DecisionJson,
});
const DelegationRow = Schema.Struct({ delegation: DelegationJson });
const EnvelopeRow = Schema.Struct({ envelope: EnvelopeJson });

// Every value written was validated at construction, so an encoding failure is a defect.
const encode =
  <T>(codec: Schema.Codec<T, string>) =>
  (value: T) =>
    Schema.encodeEffect(codec)(value).pipe(Effect.orDie);

const coordination = getTableName(coordinationTable);
const events = getTableName(eventsTable);
const delegations = getTableName(delegationsTable);
const outbox = getTableName(outboxTable);

/**
 * Provides the attempt journal on the application's `SqlClient`. Applies its embedded migrations
 * with their own `usine_attempt_journal_migrations` ledger, and runs each write in one `BEGIN
 * IMMEDIATE` transaction.
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
          yield* sql`SELECT request, revision, state, status, next_outbound AS "nextOutbound" FROM ${sql(coordination)} WHERE attempt_id = ${attemptId}`;
        if (row === undefined) return Option.none<CoordinatorSnapshot>();
        const stored = yield* Schema.decodeUnknownEffect(CoordinationRow)(row);
        const ledger =
          yield* sql`SELECT sequence, event, decision FROM ${sql(events)} WHERE attempt_id = ${attemptId} ORDER BY sequence`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(EventRow))),
          );
        const children =
          yield* sql`SELECT delegation FROM ${sql(delegations)} WHERE attempt_id = ${attemptId} ORDER BY number`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DelegationRow))),
          );
        const reservations =
          yield* sql`SELECT envelope FROM ${sql(outbox)} WHERE attempt_id = ${attemptId} ORDER BY sequence`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(EnvelopeRow))),
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
            delegations: children.map(({ delegation }) => delegation),
            outbox: reservations.map(({ envelope }) => envelope),
            nextOutbound: stored.nextOutbound,
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
            yield* Effect.logDebug("Attempt journal already open", { attemptId });
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
        return yield* load(attemptId).pipe(
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
              yield* sql`INSERT INTO ${sql(delegations)} ${sql.insert({ attempt_id: attemptId, number: intent.delegation.number, delegation })}`;
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
          } else
            yield* Effect.logDebug("Kept the decision recorded first", { attemptId, sequence });
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
          const next = Option.flatMap(stored, settled);
          if (Option.isNone(next))
            return yield* Effect.logDebug("Attempt journal already settled or never opened", {
              attemptId,
            });
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
    });
  }),
);
