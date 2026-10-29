import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import type { ChangedItem } from "@usine/github/polling";
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Queue, Ref } from "effect";

/** A repository or item to fetch early. The payload still comes from GitHub. */
export interface ItemHint {
  readonly repository: RepositoryName;
  readonly item: Option.Option<ChangedItem>;
}

/** Pending hints are bounded and coalesced; the normal poll repairs dropped hints. */
const make = Effect.gen(function* () {
  const pending = new Set<string>();
  const queue = yield* Queue.make<ItemHint>({ capacity: 128, strategy: "dropping" });
  const lastHint = yield* Ref.make(Option.none<DateTime.Utc>());
  const backoffUntil = yield* Ref.make(0);
  const key = ({ repository, item }: ItemHint) =>
    `${canonicalRepositoryName(repository)}:${Option.match(item, { onNone: () => "*", onSome: (value) => String(value.number) })}`;

  const defer = (until: Option.Option<DateTime.Utc>) =>
    Option.match(until, {
      onNone: () => Effect.void,
      onSome: (value) =>
        Ref.update(backoffUntil, (current) => Math.max(current, DateTime.toEpochMillis(value))),
    });

  const offer = Effect.fn("PollingTriggers.hint")(function* (
    repository: RepositoryName,
    item?: ChangedItem,
    requestBackoff: Option.Option<DateTime.Utc> = Option.none(),
  ) {
    yield* Effect.annotateCurrentSpan({ repository, item: item?.number });
    yield* Ref.set(lastHint, Option.some(yield* DateTime.now));
    yield* defer(requestBackoff);
    const hint = { repository, item: Option.fromUndefinedOr(item) };
    const id = key(hint);
    if (pending.has(id)) {
      yield* Effect.logDebug("Hint coalesced with a pending fetch", {
        repository,
        item: item?.number,
      });
      return;
    }
    pending.add(id);
    if (yield* Queue.offer(queue, hint)) {
      yield* Effect.logDebug("Hint queued", { repository, item: item?.number });
    } else {
      pending.delete(id);
      yield* Effect.logWarning("Hint queue full; the normal poll will refresh the repository", {
        repository,
        item: item?.number,
      });
    }
  }, Effect.uninterruptible);

  const take = Effect.uninterruptibleMask((restore) =>
    restore(Queue.take(queue)).pipe(
      Effect.tap((hint) => Effect.sync(() => pending.delete(key(hint)))),
    ),
  );
  const awaitBackoff = Effect.gen(function* () {
    while (true) {
      const until = yield* Ref.get(backoffUntil);
      const now = yield* Clock.currentTimeMillis;
      if (until <= now) return;
      yield* Effect.logInfo("GitHub request backoff delays polling and self-write Hints", {
        sleepMs: until - now,
      });
      yield* Effect.sleep(Duration.millis(until - now));
      // An operator write can extend the deadline while this consumer waits.
    }
  });

  return { offer, take, defer, awaitBackoff, lastHint: Ref.get(lastHint) };
});

/** The pending hint and request-backoff state of a polling runtime. */
export class ItemHints extends Context.Service<ItemHints, Effect.Success<typeof make>>()(
  "@usine/orchestrator/ItemHints",
) {
  static readonly layer = Layer.effect(ItemHints, make);
}
