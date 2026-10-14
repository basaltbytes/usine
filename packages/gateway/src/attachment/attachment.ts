import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Encoding, Schema } from "effect";

/**
 * Identifies one attachment from its first attach to its detach. Renewals
 * keep it; a fresh attach for the same Worker and repository gets a new one,
 * so a caller token from an earlier attachment is never honored again.
 */
export const AttachmentId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{22}$/u, { message: "Expected a 22-character attachment id" }),
).pipe(Schema.brand("AttachmentId"));
export type AttachmentId = typeof AttachmentId.Type;

/** A new attachment id: 128 random bits from the platform's cryptographic generator. */
export const newAttachmentId = Effect.sync(() =>
  AttachmentId.make(Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))),
);

/** A GitHub App installation token the gateway adds to the Worker's requests for the repository. */
export class InstallationCredential extends Schema.TaggedClass<InstallationCredential>()(
  "InstallationCredential",
  { token: Schema.Redacted(Schema.NonEmptyString) },
) {}

/**
 * No credential: requests go upstream as they are, so only what GitHub
 * serves anonymously works, which is reading a public repository.
 */
export class AnonymousCredential extends Schema.TaggedClass<AnonymousCredential>()(
  "AnonymousCredential",
  {},
) {}

/** What the gateway adds to a Worker's GitHub requests for an attached repository. */
export const AttachmentCredential = Schema.Union([InstallationCredential, AnonymousCredential]);
export type AttachmentCredential = typeof AttachmentCredential.Type;

/**
 * The executor's grant to one Worker VM for one repository: until
 * `expiresAt`, the gateway adds `credential` to that VM's requests for that
 * repository and honors the caller token issued for this attachment. The
 * executor sets `expiresAt` to the token's own expiry, so an attachment never
 * outlives its token. Several attachments may be in force for the same
 * Worker and repository, one per Attempt.
 */
export class Attachment extends Schema.Class<Attachment>("@usine/gateway/Attachment")({
  id: AttachmentId,
  worker: WorkerName,
  repository: RepositoryName,
  credential: AttachmentCredential,
  expiresAt: Schema.DateTimeUtc,
}) {
  /** Whether the attachment still grants access at `now`. */
  isLiveAt(now: DateTime.Utc): boolean {
    return DateTime.isLessThan(now, this.expiresAt);
  }
}

/** The attachment is in force. */
export class LiveAttachment extends Schema.TaggedClass<LiveAttachment>()("LiveAttachment", {
  attachment: Attachment,
}) {}

/** The attachment existed but its token has expired; the executor did not renew it. */
export class ExpiredAttachment extends Schema.TaggedClass<ExpiredAttachment>()(
  "ExpiredAttachment",
  { expiredAt: Schema.DateTimeUtc },
) {}

/** No attachment with the id is in the store: it was detached, or never attached on this gateway. */
export class MissingAttachment extends Schema.TaggedClass<MissingAttachment>()(
  "MissingAttachment",
  {},
) {}

/** The outcome of looking up an attachment by its id. */
export type AttachmentLookup = LiveAttachment | ExpiredAttachment | MissingAttachment;

/** The executor tried to attach a token that had already expired. */
export class AttachmentAlreadyExpired extends Schema.TaggedError<AttachmentAlreadyExpired>()(
  "AttachmentAlreadyExpired",
  { worker: WorkerName, repository: RepositoryName, expiresAt: Schema.DateTimeUtc },
) {}

/** A renewal named an attachment id that belongs to another Worker or repository. */
export class AttachmentConflict extends Schema.TaggedError<AttachmentConflict>()(
  "AttachmentConflict",
  { id: AttachmentId, worker: WorkerName, repository: RepositoryName },
) {}
