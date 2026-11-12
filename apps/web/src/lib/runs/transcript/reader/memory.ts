import type { RunId } from "@usine/core/run";
import { TranscriptSequence } from "@usine/engine/transcript";
import { Schema } from "effect";
import { browserArchive } from "~/lib/browser-archive";

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** A transcript row and its offset in pixels from the top of the viewport. */
export const ReadingAnchor = Schema.TaggedStruct("Anchor", {
  key: identity,
  surface: Schema.Literals(["row", "group", "result"]),
  sequence: TranscriptSequence,
  offset: Schema.Finite.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 })),
});
export type ReadingAnchor = typeof ReadingAnchor.Type;

/** The saved reader position: `Latest` to follow new events, or an anchor. */
export const ReaderPosition = Schema.Union([Schema.TaggedStruct("Latest", {}), ReadingAnchor]);
export type ReaderPosition = typeof ReaderPosition.Type;

/** The reader state saved in the browser; it contains no transcript content or tool payloads. */
export const ReaderBookmark = Schema.Struct({
  disclosures: Schema.Array(
    Schema.Struct({ key: identity, open: Schema.Boolean, groupOpen: Schema.Boolean }),
  ).check(Schema.isMaxLength(200)),
  position: ReaderPosition,
  readThrough: Schema.NullOr(TranscriptSequence),
});
export type ReaderBookmark = typeof ReaderBookmark.Type;

const maximumRuns = 20;
const record = Schema.Struct({ runId: identity, savedAt: timestamp, bookmark: ReaderBookmark });
// Version 1 archives, which also stored the conversation filter, decode as absent and are
// overwritten on the next write.
const archive = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(2),
    runs: Schema.Array(record).check(Schema.isMaxLength(maximumRuns)),
  }),
);
const storageKey = "usine:conversation-readers:v1";
const maximumAge = 30 * 24 * 60 * 60 * 1000;

/**
 * Stores reader state for up to 20 recent Runs for 30 days, in at most 512,000 characters. See
 * `browserArchive` for corrupt data and denied storage.
 */
export const readerMemory = (storage: () => Pick<Storage, "getItem" | "setItem">) => {
  const memory = browserArchive<typeof archive.Type, typeof record.Type>(
    {
      key: storageKey,
      schema: archive,
      entries: ({ runs }) => runs,
      document: (runs) => ({ version: 2, runs }),
      maximumSize: 512_000,
      span: "ConversationReader",
      label: "Conversation reader storage",
    },
    storage,
  );
  const fresh = (savedAt: number, now: number) => now >= savedAt && now - savedAt < maximumAge;
  return {
    read: (runId: RunId, now: number): ReaderBookmark | null =>
      memory.read(
        { runId },
        (runs) => {
          const saved = runs.find((entry) => entry.runId === runId);
          return saved !== undefined && fresh(saved.savedAt, now) ? saved.bookmark : null;
        },
        null,
      ),
    write: (runId: RunId, bookmark: ReaderBookmark, now: number): void =>
      memory.update({ runId }, (runs) =>
        [
          ...runs.filter((entry) => entry.runId !== runId && fresh(entry.savedAt, now)),
          { runId, savedAt: now, bookmark },
        ]
          .sort((a, b) => b.savedAt - a.savedAt)
          .slice(0, maximumRuns),
      ),
  };
};
