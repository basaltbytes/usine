import { Effect, Option, Schema } from "effect";

class BrowserStorageUnavailable extends Schema.TaggedError<
  BrowserStorageUnavailable,
  { readonly Brand: unique symbol }
>()("BrowserStorageUnavailable", { cause: Schema.Defect() }) {}

/** A JSON archive of entries in browser storage, newest entry first. */
export type BrowserArchive<Document, Entry> = {
  /** The storage key. */
  readonly key: string;
  /** Decodes and encodes the whole archive, including its version, as a JSON string. */
  readonly schema: Schema.Codec<Document, string>;
  readonly entries: (document: Document) => ReadonlyArray<Entry>;
  readonly document: (entries: ReadonlyArray<Entry>) => Document;
  /** The most entries that are saved. */
  readonly maximumEntries: number;
  /** The largest serialized archive, in UTF-16 code units, that is read or saved. */
  readonly maximumSize: number;
  /** The span name prefix, such as `LaneFold`. */
  readonly span: string;
  /** The subject of log messages, such as `Board lane fold storage`. */
  readonly label: string;
};

/**
 * Reads and updates an archive in browser storage. A corrupt, unsupported, or oversized archive
 * reads as empty with a warning, and the next update replaces it. If storage is denied, logs a
 * warning and skips persistence. `storage` is a getter because accessing `localStorage` can throw.
 */
export const browserArchive = <Document, Entry>(
  archive: BrowserArchive<Document, Entry>,
  storage: () => Pick<Storage, "getItem" | "setItem">,
) => {
  const decode = Schema.decodeUnknownOption(archive.schema, { onExcessProperty: "error" });
  const encode = Schema.encodeSync(archive.schema);
  const access = <A>(action: () => A) =>
    Effect.try({ try: action, catch: (cause) => BrowserStorageUnavailable.make({ cause }) });

  const load = Effect.gen(function* () {
    const raw = yield* access(() => storage().getItem(archive.key));
    if (raw === null) return [];
    if (raw.length > archive.maximumSize) {
      yield* Effect.logWarning(`${archive.label} discarded an oversized archive`).pipe(
        Effect.annotateLogs({ size: raw.length, maximumSize: archive.maximumSize }),
      );
      return [];
    }
    return yield* Option.match(decode(raw), {
      onNone: () =>
        Effect.logWarning(`${archive.label} discarded a corrupt or unsupported archive`).pipe(
          Effect.as([]),
        ),
      onSome: (document) => Effect.succeed(archive.entries(document)),
    });
  });

  const run = <A>(
    operation: "read" | "update",
    attributes: Readonly<Record<string, string>>,
    effect: Effect.Effect<A, BrowserStorageUnavailable>,
    fallback: A,
  ): A =>
    Effect.runSync(
      effect.pipe(
        Effect.catchTag("BrowserStorageUnavailable", () =>
          Effect.logWarning(`${archive.label} unavailable`).pipe(Effect.as(fallback)),
        ),
        Effect.annotateLogs({ operation, ...attributes }),
        Effect.withSpan(`${archive.span}.${operation}`, { attributes }),
      ),
    );

  return {
    /** Returns `select` applied to the saved entries, or `fallback` if storage is denied. */
    read: <A>(
      attributes: Readonly<Record<string, string>>,
      select: (entries: ReadonlyArray<Entry>) => A,
      fallback: A,
    ): A => run("read", attributes, Effect.map(load, select), fallback),
    /**
     * Saves the entries that `change` returns, newest first. Drops the oldest entries until the
     * archive has at most `maximumEntries` and fits `maximumSize`, and logs how many it dropped.
     * Saves nothing if one entry alone doesn't fit.
     */
    update: (
      attributes: Readonly<Record<string, string>>,
      change: (entries: ReadonlyArray<Entry>) => ReadonlyArray<Entry>,
    ): void =>
      run(
        "update",
        attributes,
        Effect.gen(function* () {
          const saved = yield* load;
          const changed = change(saved);
          const entries = changed.slice(0, archive.maximumEntries);
          let serialized = encode(archive.document(entries));
          while (serialized.length > archive.maximumSize && entries.length > 1) {
            entries.pop();
            serialized = encode(archive.document(entries));
          }
          if (serialized.length > archive.maximumSize) {
            return yield* Effect.logWarning(`${archive.label} skipped an oversized entry`).pipe(
              Effect.annotateLogs({ size: serialized.length, maximumSize: archive.maximumSize }),
            );
          }
          if (entries.length < changed.length) {
            yield* Effect.logInfo(`${archive.label} dropped the oldest entries to fit`).pipe(
              Effect.annotateLogs({
                dropped: changed.length - entries.length,
                maximumEntries: archive.maximumEntries,
                maximumSize: archive.maximumSize,
              }),
            );
          }
          yield* access(() => storage().setItem(archive.key, serialized));
        }),
        undefined,
      ),
  };
};
