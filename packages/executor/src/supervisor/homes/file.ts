import { Effect, FileSystem, Layer, Option, Stream } from "effect";
import { ConversationHomes, HomeStoreError } from "./homes.ts";

const storeError = (action: string) => (error: { readonly message: string }) =>
  HomeStoreError.make({ message: `Can't ${action}: ${error.message}` });

/**
 * Saved homes as files in `directory`, one `<key>.tar` per conversation. A save writes
 * `<key>.tar.partial`, syncs it, and renames it over the saved home, so an interrupted save leaves
 * the previous home in place. The next save of the conversation replaces a partial file that a
 * crash left.
 */
export const fileHomesLayer = (directory: string) =>
  Layer.effect(ConversationHomes)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathOf = (key: string) => `${directory}/${key}.tar`;
      return ConversationHomes.of({
        load: Effect.fn("ConversationHomes.load")(function* (key) {
          const path = pathOf(key);
          const found = yield* fs
            .exists(path)
            .pipe(Effect.mapError(storeError("find a saved home")));
          return found
            ? Option.some(fs.stream(path).pipe(Stream.mapError(storeError("read a saved home"))))
            : Option.none();
        }),
        save: Effect.fn("ConversationHomes.save")(function* <E>(
          key: Parameters<ConversationHomes["Service"]["save"]>[0],
          archive: Stream.Stream<Uint8Array, E>,
        ) {
          const path = pathOf(key);
          const partial = `${path}.partial`;
          yield* Effect.annotateCurrentSpan({ path });
          const write = Effect.gen(function* () {
            yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
            yield* fs.remove(partial, { force: true });
            const file = yield* fs.open(partial, { flag: "wx", mode: 0o600 });
            return file;
          }).pipe(Effect.mapError(storeError("start saving a home")));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* write;
              yield* Stream.runForEach(archive, (chunk) =>
                file.writeAll(chunk).pipe(Effect.mapError(storeError("write a saved home"))),
              );
              yield* file.sync.pipe(Effect.mapError(storeError("write a saved home")));
            }),
          ).pipe(
            Effect.andThen(
              fs.rename(partial, path).pipe(Effect.mapError(storeError("replace a saved home"))),
            ),
            Effect.onError(() =>
              fs.remove(partial, { force: true }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not remove a partial saved home", {
                    partial,
                    message: error.message,
                  }),
                ),
              ),
            ),
          );
        }),
      });
    }),
  );
