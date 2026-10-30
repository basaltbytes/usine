import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Schema } from "effect";
import { Base64Url } from "effect/encoding";

/**
 * The ID of an attachment, unchanged by renewals. A new attachment uses a new ID, so it cannot
 * reactivate a caller token from a detached or expired attachment.
 */
export const AttachmentId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{22}$/u, { message: "Expected a 22-character attachment ID" }),
).pipe(Schema.brand("AttachmentId"));
export type AttachmentId = typeof AttachmentId.Type;

/** Returns a new attachment ID of 128 random bits from the platform's cryptographic generator. */
export const newAttachmentId = Effect.sync(() =>
  AttachmentId.make(Base64Url.encode(crypto.getRandomValues(new Uint8Array(16)))),
);

/** A GitHub App installation token added to the worker's requests for the repository. */
export class InstallationCredential extends Schema.TaggedClass<InstallationCredential>()(
  "InstallationCredential",
  {
    /** The GitHub App installation token for the attached repository, redacted in diagnostics. */
    token: Schema.Redacted(Schema.NonEmptyString),
  },
) {}

/**
 * No credential: requests are forwarded unchanged, so only anonymous GitHub access works, such
 * as reading a public repository.
 */
export class AnonymousCredential extends Schema.TaggedClass<AnonymousCredential>()(
  "AnonymousCredential",
  {},
) {}

/** The credential added to a worker's GitHub requests for an attached repository. */
export const AttachmentCredential = Schema.Union([InstallationCredential, AnonymousCredential]);
export type AttachmentCredential = typeof AttachmentCredential.Type;

/**
 * An attachment for one worker and repository. Until `expiresAt`, the gateway adds `credential`
 * to the VM's requests for that repository and accepts the attachment's caller token.
 * `expiresAt` is the token's expiry. A worker and repository can have several attachments, one
 * per attempt.
 */
export class Attachment extends Schema.Class<Attachment>("@usine/gateway/Attachment")({
  /** The identifier used for renewal, lookup, detach, and caller-token verification. */
  id: AttachmentId,
  /** The worker allowed to use this attachment. */
  worker: WorkerName,
  /** The repository authorized by this attachment, in owner/name form. */
  repository: RepositoryName,
  /** The credential to add to GitHub requests, or anonymous access. */
  credential: AttachmentCredential,
  /** The UTC instant at which this attachment stops authorizing requests. */
  expiresAt: Schema.DateTimeUtc,
}) {
  /** Returns whether the attachment grants access at `now`. */
  isLiveAt(now: DateTime.Utc): boolean {
    return DateTime.isLessThan(now, this.expiresAt);
  }
}

/**
 * A lookup result for an active attachment. `newNames` are the names GitHub's permanent
 * redirects indicated after a rename or transfer, confirmed with GitHub's API (ADR 0027).
 */
export class LiveAttachment extends Schema.TaggedClass<LiveAttachment>()("LiveAttachment", {
  /** The active attachment, including its credential and expiry. */
  attachment: Attachment,
  /** Repository names confirmed after a rename or transfer; valid until detach or expiry (ADR 0027). */
  newNames: Schema.Array(RepositoryName),
}) {
  /** Checks `repository` against the attached name and confirmed new names, ignoring case. */
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
  {
    /** The UTC instant when the stored attachment stopped authorizing requests. */
    expiredAt: Schema.DateTimeUtc,
  },
) {}

/**
 * A lookup result for an ID that isn't in the store because it was detached or never attached on
 * this gateway.
 */
export class MissingAttachment extends Schema.TaggedClass<MissingAttachment>()(
  "MissingAttachment",
  {},
) {}

/** The result of looking up an attachment by ID: active, expired, or absent. */
export type AttachmentLookup = LiveAttachment | ExpiredAttachment | MissingAttachment;

/** The error when an attach request has an expired token. */
export class AttachmentAlreadyExpired extends Schema.TaggedError<AttachmentAlreadyExpired>()(
  "AttachmentAlreadyExpired",
  {
    /** The worker in the rejected attach or renewal request. */
    worker: WorkerName,
    /** The repository in the rejected request. */
    repository: RepositoryName,
    /** The requested UTC expiry, at or before the time of the request. */
    expiresAt: Schema.DateTimeUtc,
  },
) {}

/** The error when a renewal uses an attachment ID that belongs to another worker or repository. */
export class AttachmentConflict extends Schema.TaggedError<AttachmentConflict>()(
  "AttachmentConflict",
  {
    /** The attachment ID already assigned to a different worker or repository. */
    id: AttachmentId,
    /** The worker in the rejected renewal, which leaves the stored attachment unchanged. */
    worker: WorkerName,
    /** The repository in the rejected renewal; comparison ignores case. */
    repository: RepositoryName,
  },
) {}

/** A snapshot could not be read or replaced. Diagnostics exclude credentials and file contents. */
export class AttachmentPersistenceError extends Schema.TaggedError<AttachmentPersistenceError>()(
  "AttachmentPersistenceError",
  {
    /** Whether loading or replacing the attachment snapshot failed. */
    operation: Schema.Literals(["read", "write"]),
    /** A diagnostic explanation that excludes credentials and snapshot contents. */
    message: Schema.String,
  },
) {}
