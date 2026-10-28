import { Effect, Option, Stream } from "effect";
import type {
  ConfigurationRevision,
  ConfigurationRevisionNumber,
  ConfigurationStoreError,
} from "./model.ts";

export const watchRevisions = (
  after: ConfigurationRevisionNumber,
  readAfter: (
    number: ConfigurationRevisionNumber,
  ) => Effect.Effect<ReadonlyArray<ConfigurationRevision>, ConfigurationStoreError>,
): Stream.Stream<ConfigurationRevision, ConfigurationStoreError> =>
  Stream.paginate(after, (number) =>
    Effect.gen(function* () {
      const revisions = yield* readAfter(number);
      if (revisions.length === 0) yield* Effect.sleep("500 millis");
      return [revisions, Option.some(revisions.at(-1)?.number ?? number)] as const;
    }),
  );
