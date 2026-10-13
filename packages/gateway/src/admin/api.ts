import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
} from "effect/unstable/httpapi";
import { Attachment, AttachmentAlreadyExpired } from "../attachment/attachment.ts";
import { CallerToken } from "../caller/caller.ts";

/** An attachment as the admin API reports it: everything but the token itself. */
export class AttachmentSummary extends Schema.Class<AttachmentSummary>(
  "@usine/gateway/AttachmentSummary",
)({
  worker: WorkerName,
  repository: RepositoryName,
  credential: Schema.Literals(["InstallationCredential", "AnonymousCredential"]),
  expiresAt: Schema.DateTimeUtc,
}) {
  static fromAttachment(attachment: Attachment): AttachmentSummary {
    return new AttachmentSummary({
      worker: attachment.worker,
      repository: attachment.repository,
      credential: attachment.credential._tag,
      expiresAt: attachment.expiresAt,
    });
  }
}

/**
 * The answer to an attach: the attachment, and the caller token the Worker
 * VM presents for that repository. The token is the same for every attach of
 * the same Worker and repository, so a renewal does not change it.
 */
export class Attached extends Schema.Class<Attached>("@usine/gateway/Attached")({
  attachment: AttachmentSummary,
  callerToken: CallerToken,
}) {}

/** The answer to a detach: whether an attachment existed. */
export class Detached extends Schema.Class<Detached>("@usine/gateway/Detached")({
  detached: Schema.Boolean,
}) {}

/** The attachments in force. */
export class AttachmentList extends Schema.Class<AttachmentList>("@usine/gateway/AttachmentList")({
  attachments: Schema.Array(AttachmentSummary),
}) {}

/**
 * Requires the gateway's admin token as a bearer token on every admin
 * request; a missing or different token is answered with 401. Clients add the
 * header themselves, for example with `HttpClientRequest.bearerToken`.
 */
export class AdminAuthorization extends HttpApiMiddleware.Service<AdminAuthorization>()(
  "@usine/gateway/AdminAuthorization",
  { error: HttpApiError.Unauthorized, security: { bearer: HttpApiSecurity.bearer } },
) {}

/**
 * The API the executor calls to attach a GitHub credential to a Worker VM for
 * one repository at the start of an Attempt, renew it before the token
 * expires, and detach it at cleanup. Attachments are in memory: after a
 * gateway restart the executor's next renewal attaches again.
 */
export const GatewayAdminApi = HttpApi.make("GatewayAdminApi").add(
  HttpApiGroup.make("attachments")
    .add(
      HttpApiEndpoint.post("attach", "/v1/attachments", {
        payload: Attachment.annotate({ parseOptions: { onExcessProperty: "error" } }),
        success: Attached,
        error: AttachmentAlreadyExpired.annotate({ httpApiStatus: 422 }),
      }),
      HttpApiEndpoint.delete("detach", "/v1/attachments", {
        query: { worker: WorkerName, repository: RepositoryName },
        success: Detached,
      }),
      HttpApiEndpoint.get("list", "/v1/attachments", { success: AttachmentList }),
    )
    .middleware(AdminAuthorization),
);
