import { Effect, Layer, Option, Stream } from "effect";
import type { ConversationKey } from "../names.ts";
import { ConversationHomes } from "./homes.ts";

/** Saved homes in this process's memory, for tests. */
export const memoryHomesLayer = Layer.sync(ConversationHomes)(() => {
  const homes = new Map<ConversationKey, Uint8Array>();
  return ConversationHomes.of({
    load: (key) =>
      Effect.sync(() => Option.map(Option.fromUndefinedOr(homes.get(key)), Stream.make)),
    save: (key, archive) =>
      Stream.runCollect(archive).pipe(
        Effect.map((chunks) => {
          const archived = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
          let offset = 0;
          for (const chunk of chunks) {
            archived.set(chunk, offset);
            offset += chunk.length;
          }
          homes.set(key, archived);
        }),
      ),
  });
});
