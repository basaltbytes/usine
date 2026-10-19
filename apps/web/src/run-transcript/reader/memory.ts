import type { RunId } from "@usine/core/run";
import { TranscriptSequence } from "@usine/engine/transcript";
import { Effect, Option, Schema } from "effect";

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const timestamp = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

/** A durable conversation row and its position relative to the viewport's top edge. */
export const ReadingAnchor = Schema.Struct({
  _tag: Schema.Literal("Anchor"),
  key: identity,
  surface: Schema.Literals(["row", "group", "result"]),
  sequence: TranscriptSequence,
  offset: Schema.Number.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 })),
});
export type ReadingAnchor = typeof ReadingAnchor.Type;

/** Following latest is an intention, independent of the current transcript's height. */
export const ReaderPosition = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Latest") }),
  ReadingAnchor,
]);
export type ReaderPosition = typeof ReaderPosition.Type;

/** Browser-only reader preferences; no transcript content or tool payload is retained. */
export const ReaderBookmark = Schema.Struct({
  disclosures: Schema.Array(
    Schema.Struct({ key: identity, open: Schema.Boolean, groupOpen: Schema.Boolean }),
  ).check(Schema.isMaxLength(200)),
  position: ReaderPosition,
  readThrough: Schema.NullOr(TranscriptSequence),
});
export type ReaderBookmark = typeof ReaderBookmark.Type;

const record = Schema.Struct({ runId: identity, savedAt: timestamp, bookmark: ReaderBookmark });
// Version 1 also stored the conversation filter; its archives decode as absent and are replaced on the next write.
const archive = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(2),
    runs: Schema.Array(record).check(Schema.isMaxLength(20)),
  }),
);
const decode = Schema.decodeUnknownOption(archive, { onExcessProperty: "error" });
const encode = Schema.encodeSync(archive);
const storageKey = "usine:conversation-readers:v1";
const maximumAge = 30 * 24 * 60 * 60 * 1000;
const maximumSize = 512_000;

/**
 * Stores at most 20 recent Runs for 30 days in this browser origin. Storage denial,
 * corrupt data and quota failures leave the conversation usable without persistence.
 * The storage getter is deferred because even accessing localStorage can throw.
 */
export const readerMemory = (storage: () => Pick<Storage, "getItem" | "setItem">) => {
  const readArchive = () => {
    const raw = storage().getItem(storageKey);
    if (raw === null) return [];
    if (raw.length > maximumSize) return [];
    return Option.match(decode(raw), { onNone: () => [], onSome: (value) => value.runs });
  };
  const recover = <A>(operation: "read" | "write", runId: RunId, action: () => A, fallback: A): A =>
    Effect.runSync(
      Effect.try({ try: action, catch: () => ({ operation, runId }) }).pipe(
        Effect.catch((failure) =>
          Effect.logWarning("Conversation reader storage unavailable", failure).pipe(
            Effect.as(fallback),
          ),
        ),
        Effect.withSpan(`ConversationReader.${operation}`, { attributes: { runId } }),
      ),
    );
  return {
    read: (runId: RunId, now: number): ReaderBookmark | null =>
      recover(
        "read",
        runId,
        () => {
          const saved = readArchive().find((entry) => entry.runId === runId);
          return saved !== undefined && now >= saved.savedAt && now - saved.savedAt < maximumAge
            ? saved.bookmark
            : null;
        },
        null,
      ),
    write: (runId: RunId, bookmark: ReaderBookmark, now: number): void => {
      recover(
        "write",
        runId,
        () => {
          const runs = readArchive().filter(
            (entry) =>
              entry.runId !== runId && now >= entry.savedAt && now - entry.savedAt < maximumAge,
          );
          runs.push({ runId, savedAt: now, bookmark });
          runs.sort((a, b) => b.savedAt - a.savedAt);
          runs.splice(20);
          let serialized = encode({ version: 2, runs });
          while (serialized.length > maximumSize && runs.length > 1) {
            runs.pop();
            serialized = encode({ version: 2, runs });
          }
          storage().setItem(storageKey, serialized);
        },
        undefined,
      );
    },
  };
};
