import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import { Context, DateTime, Effect, Layer, Ref } from "effect";
import {
  type Attachment,
  AttachmentAlreadyExpired,
  type AttachmentLookup,
  ExpiredAttachment,
  LiveAttachment,
  MissingAttachment,
} from "./attachment.ts";

const SWEEP_INTERVAL = "1 minute";

const keyOf = (worker: WorkerName, repository: RepositoryName): string =>
  `${worker} ${canonicalRepositoryName(repository)}`;

/**
 * The attachments the executor has made, kept in memory only. A gateway
 * restart forgets them, and the executor attaches again when it renews or
 * restarts. Repository names compare without case, as on GitHub.
 */
export class Attachments extends Context.Service<
  Attachments,
  {
    /** Attaches a credential, replacing any earlier one for the same Worker and repository. */
    readonly attach: (attachment: Attachment) => Effect.Effect<void, AttachmentAlreadyExpired>;
    /** Removes the attachment; `false` when there was none. */
    readonly detach: (worker: WorkerName, repository: RepositoryName) => Effect.Effect<boolean>;
    /** Every attachment still in force, oldest expiry first. */
    readonly list: () => Effect.Effect<ReadonlyArray<Attachment>>;
    /** Whether the Worker has an attachment in force for the repository, and if not, why. */
    readonly find: (
      worker: WorkerName,
      repository: RepositoryName,
    ) => Effect.Effect<AttachmentLookup>;
    /** Forgets expired attachments and returns how many it removed. */
    readonly sweep: () => Effect.Effect<number>;
  }
>()("@usine/gateway/Attachments") {
  /** An empty store that sweeps expired attachments every minute while the layer is in scope. */
  static readonly layer = Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyMap<string, Attachment>>(new Map());

      const attach = Effect.fn("Attachments.attach")(function* (attachment: Attachment) {
        const { worker, repository, expiresAt } = attachment;
        yield* Effect.annotateCurrentSpan({ worker, repository });
        const now = yield* DateTime.now;
        if (!attachment.isLiveAt(now))
          return yield* new AttachmentAlreadyExpired({ worker, repository, expiresAt });
        const key = keyOf(worker, repository);
        const previous = yield* Ref.modify(entries, (current) => [
          current.get(key),
          new Map(current).set(key, attachment),
        ]);
        yield* Effect.logInfo(
          previous === undefined ? "Attached a GitHub credential" : "Replaced a GitHub credential",
          {
            worker,
            repository,
            credential: attachment.credential._tag,
            expiresAt: DateTime.formatIso(expiresAt),
          },
        );
      });

      const detach = Effect.fn("Attachments.detach")(function* (
        worker: WorkerName,
        repository: RepositoryName,
      ) {
        yield* Effect.annotateCurrentSpan({ worker, repository });
        const key = keyOf(worker, repository);
        const removed = yield* Ref.modify(entries, (current) => {
          if (!current.has(key)) return [false, current];
          const next = new Map(current);
          next.delete(key);
          return [true, next];
        });
        yield* removed
          ? Effect.logInfo("Detached a GitHub credential", { worker, repository })
          : Effect.logInfo("Nothing to detach", { worker, repository });
        return removed;
      });

      const list = Effect.fn("Attachments.list")(function* () {
        const now = yield* DateTime.now;
        const current = yield* Ref.get(entries);
        return [...current.values()]
          .filter((attachment) => attachment.isLiveAt(now))
          .sort(
            (left, right) =>
              DateTime.toEpochMillis(left.expiresAt) - DateTime.toEpochMillis(right.expiresAt),
          );
      });

      const find = Effect.fn("Attachments.find")(function* (
        worker: WorkerName,
        repository: RepositoryName,
      ) {
        const now = yield* DateTime.now;
        const attachment = (yield* Ref.get(entries)).get(keyOf(worker, repository));
        if (attachment === undefined) return new MissingAttachment();
        return attachment.isLiveAt(now)
          ? new LiveAttachment({ attachment })
          : new ExpiredAttachment({ expiredAt: attachment.expiresAt });
      });

      const sweep = Effect.fn("Attachments.sweep")(function* () {
        const now = yield* DateTime.now;
        const expired = yield* Ref.modify(entries, (current) => {
          const gone = [...current.entries()].filter(([, attachment]) => !attachment.isLiveAt(now));
          if (gone.length === 0) return [[], current];
          const next = new Map(current);
          for (const [key] of gone) next.delete(key);
          return [gone.map(([, attachment]) => attachment), next];
        });
        for (const { worker, repository, expiresAt } of expired)
          yield* Effect.logInfo("Forgot an expired GitHub credential", {
            worker,
            repository,
            expiredAt: DateTime.formatIso(expiresAt),
          });
        return expired.length;
      });

      yield* Effect.forever(Effect.sleep(SWEEP_INTERVAL).pipe(Effect.andThen(sweep()))).pipe(
        Effect.forkScoped,
      );

      return { attach, detach, list, find, sweep };
    }),
  );
}
