import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Schema } from "effect";
import { Base64Url } from "effect/encoding";

/**
 * The ID of an attachment, unchanged by renewals. A new attach for the same Worker and
 * repository gets a new ID, so an earlier caller token is never accepted again.
 */
export const AttachmentId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{22}$/u, { message: "Expected a 22-character attachment ID" }),
).pipe(Schema.brand("AttachmentId"));
export type AttachmentId = typeof AttachmentId.Type;

/** Returns a new attachment ID of 128 random bits from the platform's cryptographic generator. */
export const newAttachmentId = Effect.sync(() =>
  AttachmentId.make(Base64Url.encode(crypto.getRandomValues(new Uint8Array(16)))),
);

/** A GitHub App installation token added to the Worker's requests for the repository. */
export class InstallationCredential extends Schema.TaggedClass<InstallationCredential>()(
  "InstallationCredential",
  { token: Schema.Redacted(Schema.NonEmptyString) },
) {}

/**
 * No credential: requests are forwarded unchanged, so only anonymous GitHub access works, such
 * as reading a public repository.
 */
export class AnonymousCredential extends Schema.TaggedClass<AnonymousCredential>()(
  "AnonymousCredential",
  {},
) {}

/** The credential added to a Worker's GitHub requests for an attached repository. */
export const AttachmentCredential = Schema.Union([InstallationCredential, AnonymousCredential]);
export type AttachmentCredential = typeof AttachmentCredential.Type;

/**
 * A grant to one Worker VM for one repository. Until `expiresAt`, the Gateway adds `credential`
 * to the VM's requests for that repository and accepts the attachment's caller token.
 * `expiresAt` is the token's expiry. A Worker and repository can have several attachments, one
 * per Attempt.
 */
export class Attachment extends Schema.Class<Attachment>("@usine/gateway/Attachment")({
  id: AttachmentId,
  worker: WorkerName,
  repository: RepositoryName,
  credential: AttachmentCredential,
  expiresAt: Schema.DateTimeUtc,
}) {
  /** Returns whether the attachment grants access at `now`. */
  isLiveAt(now: DateTime.Utc): boolean {
    return DateTime.isLessThan(now, this.expiresAt);
  }
}

/**
 * A lookup result for an active attachment. `newNames` are the names GitHub's permanent
 * redirects gave the attached repository after a rename or transfer.
 */
export class LiveAttachment extends Schema.TaggedClass<LiveAttachment>()("LiveAttachment", {
  attachment: Attachment,
  newNames: Schema.Array(RepositoryName),
}) {
  /** Returns whether `repository` is the attached repository, by its attached name or a new name. */
  serves(repository: RepositoryName): boolean {
    const wanted = canonicalRepositoryName(repository);
    return [this.attachment.repository, ...this.newNames].some(
      (name) => canonicalRepositoryName(name) === wanted,
    );
  }
}

/** A lookup result for an attachment whose token expired without renewal. */
export class ExpiredAttachment extends Schema.TaggedClass<ExpiredAttachment>()(
  "ExpiredAttachment",
  { expiredAt: Schema.DateTimeUtc },
) {}

/** A lookup result for an ID that isn't in the store because it was detached or never attached on this Gateway. */
export class MissingAttachment extends Schema.TaggedClass<MissingAttachment>()(
  "MissingAttachment",
  {},
) {}

export type AttachmentLookup = LiveAttachment | ExpiredAttachment | MissingAttachment;

/** The error when an attach request has an expired token. */
export class AttachmentAlreadyExpired extends Schema.TaggedError<AttachmentAlreadyExpired>()(
  "AttachmentAlreadyExpired",
  { worker: WorkerName, repository: RepositoryName, expiresAt: Schema.DateTimeUtc },
) {}

/** The error when a renewal uses an attachment ID that belongs to another Worker or repository. */
export class AttachmentConflict extends Schema.TaggedError<AttachmentConflict>()(
  "AttachmentConflict",
  { id: AttachmentId, worker: WorkerName, repository: RepositoryName },
) {}
