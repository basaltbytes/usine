import {
  Context,
  Effect,
  Layer,
  PubSub,
  Schema,
  Stream,
  SynchronizedRef,
  type Scope,
} from "effect";
import { AccessScope } from "./access.ts";
import { LoopName } from "./loop.ts";
import { RepositoryName } from "./repository.ts";

/** Identifies a read affected by a committed write, without carrying its contents. */
export const ChangeTarget = Schema.Struct({
  kind: Schema.Literals([
    "project",
    "item",
    "run",
    "attempt",
    "worker",
    "configuration",
    "attention",
    "activity",
    "navigation",
  ]),
  id: Schema.String,
});
export type ChangeTarget = typeof ChangeTarget.Type;

/** Repository and loop ownership are resolved from configuration when a subscriber reads a notice. */
export const ChangeAudience = Schema.Union([
  AccessScope,
  Schema.Struct({ _tag: Schema.Literal("Repository"), repository: RepositoryName }),
  Schema.Struct({ _tag: Schema.Literal("Loop"), loop: LoopName }),
  Schema.Struct({ _tag: Schema.Literal("Readers") }),
]);
export type ChangeAudience = typeof ChangeAudience.Type;

export interface ScopedChange {
  readonly audience: ChangeAudience;
  readonly target: ChangeTarget;
}
export interface CommittedChanges {
  readonly revision: number;
  readonly changes: ReadonlyArray<ScopedChange>;
}
interface Journal {
  readonly revision: number;
  readonly history: ReadonlyArray<CommittedChanges>;
}
interface ChangeBusService {
  readonly publish: (changes: ReadonlyArray<ScopedChange>) => Effect.Effect<void>;
  /** Subscribes before reading replay state so writes cannot fall between replay and live delivery. */
  readonly open: Effect.Effect<
    Journal & { readonly live: Stream.Stream<CommittedChanges> },
    never,
    Scope.Scope
  >;
}

/** Optional observation for standalone blocks; the server provides one bus for its entire lifetime. */
export const ChangeBus = Context.Reference<ChangeBusService>("@usine/core/ChangeBus", {
  defaultValue: () => ({
    publish: () => Effect.void,
    open: Effect.succeed({ revision: 0, history: [], live: Stream.never }),
  }),
});

/** Retains at most 256 committed notices and drops old messages for slow subscribers. */
export const changeBusLayer = Layer.effect(
  ChangeBus,
  Effect.gen(function* () {
    const messages = yield* Effect.acquireRelease(
      PubSub.sliding<CommittedChanges>(256),
      PubSub.shutdown,
    );
    const state = yield* SynchronizedRef.make<Journal>({ revision: Date.now(), history: [] });
    const publish = Effect.fn("ChangeBus.publish")(function* (
      changes: ReadonlyArray<ScopedChange>,
    ) {
      if (changes.length === 0) return;
      yield* SynchronizedRef.updateEffect(state, (previous) =>
        Effect.gen(function* () {
          const notice = { revision: previous.revision + 1, changes };
          yield* Effect.annotateCurrentSpan({ revision: notice.revision, targets: changes.length });
          yield* PubSub.publish(messages, notice);
          yield* Effect.logDebug("Committed change notice published", {
            revision: notice.revision,
            targets: changes.map(({ target }) => target),
          });
          return { revision: notice.revision, history: [...previous.history, notice].slice(-256) };
        }),
      ).pipe(Effect.uninterruptible);
    });
    const open = Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(messages);
      const journal = yield* SynchronizedRef.get(state);
      return { ...journal, live: Stream.fromSubscription(subscription) };
    });
    return { publish, open };
  }),
);
