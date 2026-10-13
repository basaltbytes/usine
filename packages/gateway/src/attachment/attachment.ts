import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Schema } from "effect";

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
 * repository and honors the VM's caller token for it. The executor sets
 * `expiresAt` to the token's own expiry, so an attachment never outlives its
 * token.
 */
export class Attachment extends Schema.Class<Attachment>("@usine/gateway/Attachment")({
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

/** No attachment exists for the Worker and repository. */
export class MissingAttachment extends Schema.TaggedClass<MissingAttachment>()(
  "MissingAttachment",
  {},
) {}

/** The outcome of looking up a Worker's attachment for a repository. */
export type AttachmentLookup = LiveAttachment | ExpiredAttachment | MissingAttachment;

/** The executor tried to attach a token that had already expired. */
export class AttachmentAlreadyExpired extends Schema.TaggedError<AttachmentAlreadyExpired>()(
  "AttachmentAlreadyExpired",
  { worker: WorkerName, repository: RepositoryName, expiresAt: Schema.DateTimeUtc },
) {}
