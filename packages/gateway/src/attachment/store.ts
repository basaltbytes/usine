import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import { Context, Data, DateTime, Effect, Layer, Match, Ref } from "effect";
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

/** A stored attachment and the new names GitHub gave its repository while it was live. */
interface Entry {
  readonly attachment: Attachment;
  readonly newNames: ReadonlyArray<RepositoryName>;
}

/** What `learnNewName` did: added the name to the attachment, or kept its names, and why. */
type Learning = Data.TaggedEnum<{
  Learned: { readonly attachment: Attachment };
  Kept: { readonly reason: "not-live" | "already-served" };
}>;
const Learning = Data.taggedEnum<Learning>();

/**
 * The in-memory attachment store, keyed by attachment ID. A Gateway restart clears it; the
 * executor re-attaches with the same IDs when it renews or restarts.
 */
export class Attachments extends Context.Service<
  Attachments,
  {
    /**
     * Stores an attachment, or replaces the credential and expiry of the one with the same ID.
     * Fails with `AttachmentConflict` if the ID belongs to another Worker or repository.
     */
    readonly attach: (
      attachment: Attachment,
    ) => Effect.Effect<void, AttachmentAlreadyExpired | AttachmentConflict>;
    /** Removes the attachment. Returns `false` if it didn't exist. */
    readonly detach: (id: AttachmentId) => Effect.Effect<boolean>;
    /** Returns the active attachments, earliest expiry first. */
    readonly list: () => Effect.Effect<ReadonlyArray<Attachment>>;
    /** Returns whether the attachment is active, expired, or missing. */
    readonly find: (id: AttachmentId) => Effect.Effect<AttachmentLookup>;
    /**
     * Records `name` as the attached repository's new name, from GitHub's permanent redirect of a
     * request for it, so the attachment serves paths that name it until detach or expiry. Does
     * nothing if the attachment isn't live or already serves `name`.
     */
    readonly learnNewName: (id: AttachmentId, name: RepositoryName) => Effect.Effect<void>;
    /** Removes expired attachments and returns the number removed. */
    readonly sweep: () => Effect.Effect<number>;
  }
>()("@usine/gateway/Attachments") {
  /** An empty store that removes expired attachments every minute while the layer is in scope. */
  static readonly layer = Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyMap<AttachmentId, Entry>>(new Map());

      const attach = Effect.fn("Attachments.attach")(function* (attachment: Attachment) {
        const { id, worker, repository, expiresAt } = attachment;
        yield* Effect.annotateCurrentSpan({ attachment: id, worker, repository });
        const now = yield* DateTime.now;
        if (!attachment.isLiveAt(now))
          return yield* new AttachmentAlreadyExpired({ worker, repository, expiresAt });
        const outcome = yield* Ref.modify(entries, (current) => {
          const previous = current.get(id);
          if (previous !== undefined && !samePair(previous.attachment, attachment))
            return ["conflict" as const, current];
          return [
            previous === undefined ? ("attached" as const) : ("renewed" as const),
            new Map(current).set(id, { attachment, newNames: previous?.newNames ?? [] }),
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
          const entry = current.get(id);
          if (entry === undefined) return [entry, current];
          const next = new Map(current);
          next.delete(id);
          return [entry.attachment, next];
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
          .map(({ attachment }) => attachment)
          .filter((attachment) => attachment.isLiveAt(now))
          .sort(
            (left, right) =>
              DateTime.toEpochMillis(left.expiresAt) - DateTime.toEpochMillis(right.expiresAt),
          );
      });

      const find = Effect.fn("Attachments.find")(function* (id: AttachmentId) {
        const now = yield* DateTime.now;
        const entry = (yield* Ref.get(entries)).get(id);
        if (entry === undefined) return new MissingAttachment();
        return entry.attachment.isLiveAt(now)
          ? new LiveAttachment(entry)
          : new ExpiredAttachment({ expiredAt: entry.attachment.expiresAt });
      });

      const learnNewName = Effect.fn("Attachments.learnNewName")(function* (
        id: AttachmentId,
        name: RepositoryName,
      ) {
        yield* Effect.annotateCurrentSpan({ attachment: id, newName: name });
        const now = yield* DateTime.now;
        const learning = yield* Ref.modify(
          entries,
          (current): [Learning, ReadonlyMap<AttachmentId, Entry>] => {
            const entry = current.get(id);
            if (entry === undefined || !entry.attachment.isLiveAt(now))
              return [Learning.Kept({ reason: "not-live" }), current];
            if (new LiveAttachment(entry).serves(name))
              return [Learning.Kept({ reason: "already-served" }), current];
            return [
              Learning.Learned({ attachment: entry.attachment }),
              new Map(current).set(id, { ...entry, newNames: [...entry.newNames, name] }),
            ];
          },
        );
        yield* Match.valueTags(learning, {
          Learned: ({ attachment }) =>
            Effect.logInfo("Learned the new name of an attached repository", {
              attachment: id,
              worker: attachment.worker,
              repository: attachment.repository,
              newName: name,
            }),
          Kept: ({ reason }) =>
            Effect.logDebug("Kept the names an attachment serves", {
              attachment: id,
              newName: name,
              reason,
            }),
        });
      });

      const sweep = Effect.fn("Attachments.sweep")(function* () {
        const now = yield* DateTime.now;
        const expired = yield* Ref.modify(entries, (current) => {
          const gone = [...current.values()]
            .map(({ attachment }) => attachment)
            .filter((attachment) => !attachment.isLiveAt(now));
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

      return { attach, detach, list, find, learnNewName, sweep };
    }),
  );
}
