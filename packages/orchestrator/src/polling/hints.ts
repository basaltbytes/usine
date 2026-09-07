import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import type { ChangedItem } from "@usine/github/polling";
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Queue, Ref } from "effect";

/** A self-write identifies an Item to fetch; its payload still comes from GitHub. */
export interface ItemHint {
  readonly repository: RepositoryName;
  readonly item: ChangedItem;
}

/** Pending Hints are bounded and coalesced; the normal poll repairs dropped nudges. */
const make = Effect.gen(function* () {
  const pending = new Set<string>();
  const queue = yield* Queue.make<ItemHint>({ capacity: 128, strategy: "dropping" });
  const backoffUntil = yield* Ref.make(0);
  const key = ({ repository, item }: ItemHint) =>
    `${canonicalRepositoryName(repository)}:${item.number}`;

  const defer = (until: Option.Option<DateTime.Utc>) =>
    Option.match(until, {
      onNone: () => Effect.void,
      onSome: (value) =>
        Ref.update(backoffUntil, (current) => Math.max(current, DateTime.toEpochMillis(value))),
    });

  const offer = Effect.fn("PollingTriggers.hint")(function* (
    repository: RepositoryName,
    item: ChangedItem,
    requestBackoff: Option.Option<DateTime.Utc> = Option.none(),
  ) {
    yield* Effect.annotateCurrentSpan({ repository, item: item.number });
    yield* defer(requestBackoff);
    const hint = { repository, item };
    const id = key(hint);
    if (pending.has(id)) {
      yield* Effect.logDebug("Self-write Hint coalesced with a pending Item fetch", {
        repository,
        item: item.number,
      });
      return;
    }
    pending.add(id);
    if (yield* Queue.offer(queue, hint)) {
      yield* Effect.logDebug("Self-write Hint queued", { repository, item: item.number });
    } else {
      pending.delete(id);
      yield* Effect.logWarning(
        "Self-write Hint queue full; the normal poll will refresh the Item",
        { repository, item: item.number },
      );
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

  return { offer, take, defer, awaitBackoff };
});

/** Private pending Hint and request-backoff state owned by a polling runtime. */
export class ItemHints extends Context.Service<ItemHints, Effect.Success<typeof make>>()(
  "@usine/orchestrator/ItemHints",
) {
  static readonly layer = Layer.effect(ItemHints, make);
}
