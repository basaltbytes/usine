import { type Brand, Context, type Effect, type Option, Schema, type Stream } from "effect";
import type { ConversationKey } from "../names.ts";

/** The orchestrator couldn't read or write a conversation's saved home. */
export class HomeStoreError extends Schema.TaggedError<
  HomeStoreError,
  Brand.Brand<"@usine/executor/supervisor/homes/HomeStoreError">
>("@usine/executor/HomeStoreError")("HomeStoreError", {
  message: Schema.NonEmptyString,
}) {}

/**
 * The saved home of each supervisor conversation on the orchestrator: a tar archive of the
 * harness's home directory, which a turn restores into its sandbox and saves when it ends.
 */
export class ConversationHomes extends Context.Service<
  ConversationHomes,
  {
    /** The archive of the conversation's saved home, or `None` when it has none. */
    readonly load: (
      key: ConversationKey,
    ) => Effect.Effect<Option.Option<Stream.Stream<Uint8Array, HomeStoreError>>, HomeStoreError>;
    /**
     * Replaces the conversation's saved home with `archive` once `archive` ends. When `archive`
     * or the write fails, the saved home stays as it was.
     */
    readonly save: <E>(
      key: ConversationKey,
      archive: Stream.Stream<Uint8Array, E>,
    ) => Effect.Effect<void, E | HomeStoreError>;
  }
>()("@usine/executor/supervisor/homes/homes/ConversationHomes") {}
