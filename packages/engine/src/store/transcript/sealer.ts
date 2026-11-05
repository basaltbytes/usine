import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { SqlError } from "effect/sql";
import { AttemptId } from "@usine/core/attempt";
import { and, asc, eq, gt, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";
import {
  Array as EffectArray,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect";
import { RunDatabase } from "../../database/database.ts";
import {
  attempts,
  attemptTranscripts,
  transcriptSeals,
  transcriptSegments,
} from "../../database/schema.ts";
import { EnginePersistenceError } from "../../engine/error.ts";
import { TranscriptSequence } from "../../transcript.ts";
import { TranscriptCodec } from "./codec.ts";
import { StoredTranscriptRow } from "./segments.ts";

const diagnosticMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

const failureDiagnostic = (cause: unknown): string => {
  if (Schema.isSchemaError(cause)) return cause.message;
  if (Schema.is(EnginePersistenceError)(cause) || Schema.is(EffectDrizzleQueryError)(cause))
    return failureDiagnostic(cause.cause);
  if (Schema.is(SqlError.SqlError)(cause)) return failureDiagnostic(cause.reason.cause);
  return Option.match(diagnosticMessage(cause), {
    onNone: () => "Unknown storage failure",
    onSome: ({ message }) => message,
  });
};

/** SQLite maintenance, supplied alongside its database without changing the run-store port. */
export class TranscriptSealer extends Context.Service<
  TranscriptSealer,
  {
    readonly sealNext: Effect.Effect<boolean, EnginePersistenceError>;
    readonly run: Effect.Effect<never>;
  }
>()("@usine/engine/store/transcript/sealer/TranscriptSealer") {}

export const transcriptSealerLayer = Layer.effect(
  TranscriptSealer,
  Effect.gen(function* () {
    const database = yield* RunDatabase;
    const codec = yield* TranscriptCodec;
    const cursor = yield* Ref.make(Option.none<AttemptId>());
    const invalidAttempts = yield* Ref.make<ReadonlySet<AttemptId>>(new Set());
    const sealNext = Effect.fn("SqliteTranscript.sealNext")(
      function* () {
        const now = yield* DateTime.now;
        const after = yield* Ref.get(cursor);
        const invalid = yield* Ref.get(invalidAttempts);
        const candidates = yield* database
          .select({ attemptId: attempts.attemptId, startedAt: attempts.startedAt })
          .from(attempts)
          .leftJoin(transcriptSeals, eq(transcriptSeals.attemptId, attempts.attemptId))
          .where(
            and(
              isNotNull(attempts.outcomeJson),
              invalid.size === 0 ? undefined : notInArray(attempts.attemptId, [...invalid]),
              isNull(transcriptSeals.attemptId),
              lte(
                sql`coalesce(${attempts.endedAt}, ${attempts.startedAt})`,
                DateTime.formatIso(DateTime.subtract(now, { hours: 1 })),
              ),
              Option.match(after, {
                onNone: () => undefined,
                onSome: (id) => gt(attempts.attemptId, id),
              }),
            ),
          )
          .orderBy(asc(attempts.attemptId))
          .limit(1)
          .execute();
        const candidate = (yield* Schema.decodeEffect(
          Schema.Array(Schema.Struct({ attemptId: AttemptId, startedAt: Schema.String })),
        )(candidates))[0];
        if (candidate === undefined) {
          yield* Ref.set(cursor, Option.none());
          yield* Effect.logDebug("Transcript sealing pass complete; waiting for ended attempts");
          return false;
        }
        const { attemptId } = candidate;
        yield* Effect.annotateCurrentSpan({ attemptId });
        // Advance before compression so one failing attempt does not prevent the rest from sealing.
        yield* Ref.set(cursor, Option.some(attemptId));
        return yield* Effect.gen(function* () {
          const raw = yield* database
            .select({
              sequence: attemptTranscripts.sequence,
              direction: attemptTranscripts.direction,
              channelSequence: attemptTranscripts.channelSequence,
              receivedAt: attemptTranscripts.receivedAt,
              envelope: attemptTranscripts.envelope,
            })
            .from(attemptTranscripts)
            .where(eq(attemptTranscripts.attemptId, attemptId))
            .orderBy(asc(attemptTranscripts.sequence))
            .execute();
          const rows = yield* Schema.decodeUnknownEffect(Schema.Array(StoredTranscriptRow))(raw, {
            onExcessProperty: "error",
          });
          const lastSequence = rows.at(-1)?.sequence ?? null;
          const segments = yield* Effect.forEach(EffectArray.chunksOf(rows, 500), (chunk) =>
            Effect.gen(function* () {
              const lines = yield* Effect.forEach(chunk, (row) =>
                Schema.encodeEffect(Schema.fromJsonString(StoredTranscriptRow))(row),
              );
              const text = lines.join("\n") + "\n";
              const body = yield* codec.compress(text);
              return {
                attemptId,
                firstSequence: chunk[0].sequence,
                lastSequence: EffectArray.lastNonEmpty(chunk).sequence,
                rows: chunk.length,
                rawBytes: new TextEncoder().encode(text).byteLength,
                codec: "brotli" as const,
                body,
              };
            }),
          );
          const sealed = yield* database.transaction((transaction) =>
            Effect.gen(function* () {
              const positions = yield* transaction
                .select({ sequence: sql<number | null>`max(${attemptTranscripts.sequence})` })
                .from(attemptTranscripts)
                .where(eq(attemptTranscripts.attemptId, attemptId))
                .execute();
              const current = yield* Schema.decodeEffect(
                Schema.Array(Schema.Struct({ sequence: Schema.NullOr(TranscriptSequence) })),
              )(positions);
              const seals = yield* transaction
                .select({ attemptId: transcriptSeals.attemptId })
                .from(transcriptSeals)
                .where(eq(transcriptSeals.attemptId, attemptId))
                .execute();
              if ((current[0]?.sequence ?? null) !== lastSequence || seals.length > 0) {
                yield* Effect.logInfo("Transcript changed during compression; sealing skipped", {
                  attemptId,
                  lastSequence,
                });
                return false;
              }
              for (const segment of segments)
                yield* transaction.insert(transcriptSegments).values(segment).execute();
              const lastChannelSequence = (direction: "inbound" | "outbound") =>
                rows.reduce<number | null>(
                  (last, row) =>
                    row.direction === direction ? Math.max(last ?? 0, row.channelSequence) : last,
                  null,
                );
              yield* transaction
                .insert(transcriptSeals)
                .values({
                  attemptId,
                  sealedAt: DateTime.formatIso(now),
                  lastInboundSequence: lastChannelSequence("inbound"),
                  lastOutboundSequence: lastChannelSequence("outbound"),
                  lastReceivedAt: rows.at(-1)?.receivedAt ?? candidate.startedAt,
                })
                .execute();
              yield* transaction
                .delete(attemptTranscripts)
                .where(eq(attemptTranscripts.attemptId, attemptId))
                .execute();
              return true;
            }),
          );
          yield* Effect.logInfo(
            sealed ? "Attempt transcript sealed" : "Attempt transcript remains hot",
            {
              attemptId,
              rows: rows.length,
              segments: segments.length,
              rawBytes: segments.reduce((total, segment) => total + segment.rawBytes, 0),
              compressedBytes: segments.reduce(
                (total, segment) => total + segment.body.byteLength,
                0,
              ),
            },
          );
          return true;
        }).pipe(
          Effect.tapError((cause) =>
            Effect.gen(function* () {
              const invalid = Schema.isSchemaError(cause);
              if (invalid)
                yield* Ref.update(invalidAttempts, (ids) => new Set([...ids, attemptId]));
              yield* Effect.logWarning("Attempt transcript sealing failed", {
                attemptId,
                errorTag: cause._tag,
                diagnostic: failureDiagnostic(cause),
                retry: invalid ? "after restart" : "next pass",
              });
            }),
          ),
        );
      },
      Effect.mapError((cause) =>
        Schema.is(EnginePersistenceError)(cause)
          ? cause
          : EnginePersistenceError.make({ operation: "seal ended attempt transcript", cause }),
      ),
    );
    const run = Effect.forever(
      Effect.gen(function* () {
        const busy = yield* sealNext().pipe(
          Effect.catchTag("EnginePersistenceError", (cause) =>
            Effect.logWarning("Transcript sealing failed; continuing with the next attempt", {
              operation: cause.operation,
              errorTag: cause._tag,
            }).pipe(Effect.as(true)),
          ),
        );
        yield* Effect.sleep(busy ? "1 second" : "1 minute");
      }),
    );
    return { sealNext: sealNext(), run };
  }),
);

/** Starts SQLite transcript maintenance in the local runtime scope. */
export const transcriptMaintenanceLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sealer = yield* TranscriptSealer;
    yield* Effect.forkScoped(sealer.run);
  }),
);
