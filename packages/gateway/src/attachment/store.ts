import { canonicalRepositoryName } from "@usine/core/repository";
import { Context, DateTime, Effect, Layer, Ref } from "effect";
import {
  type Attachment,
  AttachmentAlreadyExpired,
  AttachmentConflict,
  type AttachmentId,
  type AttachmentLookup,
  ExpiredAttachment,
  LiveAttachment,
  MissingAttachment,
} from "./attachment.ts";

const SWEEP_INTERVAL = "1 minute";

const samePair = (left: Attachment, right: Attachment): boolean =>
  left.worker === right.worker &&
  canonicalRepositoryName(left.repository) === canonicalRepositoryName(right.repository);

/**
 * The attachments the executor has made, keyed by attachment id and kept in
 * memory only. A gateway restart forgets them, and the executor attaches
 * again, with the same ids, when it renews or restarts.
 */
export class Attachments extends Context.Service<
  Attachments,
  {
    /**
     * Stores an attachment, or renews the one with the same id: the new
     * credential and expiry replace the old ones. An id already used for
     * another Worker or repository is refused.
     */
    readonly attach: (
      attachment: Attachment,
    ) => Effect.Effect<void, AttachmentAlreadyExpired | AttachmentConflict>;
    /** Removes the attachment; `false` when there was none. */
    readonly detach: (id: AttachmentId) => Effect.Effect<boolean>;
    /** Every attachment still in force, oldest expiry first. */
    readonly list: () => Effect.Effect<ReadonlyArray<Attachment>>;
    /** Whether the attachment is in force, and if not, why. */
    readonly find: (id: AttachmentId) => Effect.Effect<AttachmentLookup>;
    /** Forgets expired attachments and returns how many it removed. */
    readonly sweep: () => Effect.Effect<number>;
  }
>()("@usine/gateway/Attachments") {
  /** An empty store that sweeps expired attachments every minute while the layer is in scope. */
  static readonly layer = Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyMap<AttachmentId, Attachment>>(new Map());

      const attach = Effect.fn("Attachments.attach")(function* (attachment: Attachment) {
        const { id, worker, repository, expiresAt } = attachment;
        yield* Effect.annotateCurrentSpan({ attachment: id, worker, repository });
        const now = yield* DateTime.now;
        if (!attachment.isLiveAt(now))
          return yield* new AttachmentAlreadyExpired({ worker, repository, expiresAt });
        const outcome = yield* Ref.modify(entries, (current) => {
          const previous = current.get(id);
          if (previous !== undefined && !samePair(previous, attachment))
            return ["conflict" as const, current];
          return [
            previous === undefined ? ("attached" as const) : ("renewed" as const),
            new Map(current).set(id, attachment),
          ];
        });
        if (outcome === "conflict")
          return yield* new AttachmentConflict({ id, worker, repository });
        yield* Effect.logInfo(
          outcome === "attached" ? "Attached a GitHub credential" : "Renewed a GitHub credential",
          {
            attachment: id,
            worker,
            repository,
            credential: attachment.credential._tag,
            expiresAt: DateTime.formatIso(expiresAt),
          },
        );
      });

      const detach = Effect.fn("Attachments.detach")(function* (id: AttachmentId) {
        yield* Effect.annotateCurrentSpan({ attachment: id });
        const removed = yield* Ref.modify(entries, (current) => {
          const attachment = current.get(id);
          if (attachment === undefined) return [attachment, current];
          const next = new Map(current);
          next.delete(id);
          return [attachment, next];
        });
        if (removed === undefined) {
          yield* Effect.logInfo("Nothing to detach", { attachment: id });
          return false;
        }
        yield* Effect.logInfo("Detached a GitHub credential", {
          attachment: id,
          worker: removed.worker,
          repository: removed.repository,
        });
        return true;
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

      const find = Effect.fn("Attachments.find")(function* (id: AttachmentId) {
        const now = yield* DateTime.now;
        const attachment = (yield* Ref.get(entries)).get(id);
        if (attachment === undefined) return new MissingAttachment();
        return attachment.isLiveAt(now)
          ? new LiveAttachment({ attachment })
          : new ExpiredAttachment({ expiredAt: attachment.expiresAt });
      });

      const sweep = Effect.fn("Attachments.sweep")(function* () {
        const now = yield* DateTime.now;
        const expired = yield* Ref.modify(entries, (current) => {
          const gone = [...current.values()].filter((attachment) => !attachment.isLiveAt(now));
          if (gone.length === 0) return [gone, current];
          const next = new Map(current);
          for (const { id } of gone) next.delete(id);
          return [gone, next];
        });
        for (const { id, worker, repository, expiresAt } of expired)
          yield* Effect.logInfo("Forgot an expired GitHub credential", {
            attachment: id,
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
