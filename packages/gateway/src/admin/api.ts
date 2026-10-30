import { RepositoryName } from "@usine/core/repository";
import { GatewayCredentialKind, WorkerName } from "@usine/core/worker";
import { Option, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
} from "effect/http-api";
import {
  type Attachment,
  AttachmentAlreadyExpired,
  AttachmentConflict,
  AttachmentPersistenceError,
  AttachmentCredential,
  AttachmentId,
} from "../attachment/attachment.ts";
import { CallerToken } from "../caller/caller.ts";
import {
  credentialKind,
  type LlmProvider,
  LlmProviderName,
  type LlmProviders,
} from "../llm/llm.ts";

export { AttachmentId, InstallationCredential } from "../attachment/attachment.ts";
export { CallerToken, GATEWAY_TOKEN_HEADER } from "../caller/caller.ts";

/** A request to attach one attempt's credential for one worker and repository until it expires. */
export class AttachRequest extends Schema.Class<AttachRequest>("@usine/gateway/AttachRequest")({
  /** The worker allowed to use the attachment. */
  worker: WorkerName,
  /** The repository authorized by the credential, in owner/name form. */
  repository: RepositoryName,
  /** The installation token to inject, or anonymous access for public repositories. */
  credential: AttachmentCredential,
  /** The UTC expiry of the credential; an expiry at or before now returns HTTP 422. */
  expiresAt: Schema.DateTimeUtc,
}) {}

/** An attachment without its token. */
export class AttachmentSummary extends Schema.Class<AttachmentSummary>(
  "@usine/gateway/AttachmentSummary",
)({
  /** The stable attachment ID used for renewals and detach requests. */
  id: AttachmentId,
  /** The worker authorized by the attachment. */
  worker: WorkerName,
  /** The repository recorded when the attachment was created. */
  repository: RepositoryName,
  /** The credential kind; the installation token is omitted. */
  credential: Schema.Literals(["InstallationCredential", "AnonymousCredential"]),
  /** The UTC instant at which the attachment stops authorizing requests. */
  expiresAt: Schema.DateTimeUtc,
}) {
  /** Copies the metadata from `attachment`, replacing its credential with the credential kind. */
  static fromAttachment(attachment: Attachment): AttachmentSummary {
    return new AttachmentSummary({
      id: attachment.id,
      worker: attachment.worker,
      repository: attachment.repository,
      credential: attachment.credential._tag,
      expiresAt: attachment.expiresAt,
    });
  }
}

/**
 * The response to an attach or renew: the attachment and the worker VM's caller token.
 * Renewing with the same attachment ID, worker, and repository spelling returns the same token.
 */
export class Attached extends Schema.Class<Attached>("@usine/gateway/Attached")({
  /** The stored attachment metadata without its installation token. */
  attachment: AttachmentSummary,
  /** The token to give the attempt in place of credentials; unchanged when renewing the same claims. */
  callerToken: CallerToken,
}) {}

/** The response to a detach. `detached` is whether the attachment existed. */
export class Detached extends Schema.Class<Detached>("@usine/gateway/Detached")({
  /** Whether an attachment existed and was removed; `false` for an unknown or already detached ID. */
  detached: Schema.Boolean,
}) {}

/** The active attachments returned by the admin API, without their credentials. */
export class AttachmentList extends Schema.Class<AttachmentList>("@usine/gateway/AttachmentList")({
  /** Active attachments ordered by earliest expiry, with credentials omitted. */
  attachments: Schema.Array(AttachmentSummary),
}) {}

/** An LLM provider the gateway has a credential for, with the credential kind but not the credential. */
export class LlmProviderSummary extends Schema.Class<LlmProviderSummary>(
  "@usine/gateway/LlmProviderSummary",
)({
  /** The configured LLM provider identified by its gateway path prefix. */
  provider: LlmProviderName,
  /** Whether requests use an API key or a subscription credential. */
  credential: GatewayCredentialKind,
}) {}

/**
 * The LLM providers the gateway forwards to, with each credential kind. Providers without a
 * credential aren't listed.
 */
export class LlmProviderList extends Schema.Class<LlmProviderList>(
  "@usine/gateway/LlmProviderList",
)({
  /** Configured providers and credential kinds, excluding providers with no credential. */
  providers: Schema.Array(LlmProviderSummary),
}) {
  /** Lists configured providers in Anthropic, then OpenAI order, exposing only their credential kinds. */
  static fromProviders({ anthropic, openai }: LlmProviders): LlmProviderList {
    const listed = (provider: LlmProviderName, configured: Option.Option<LlmProvider>) =>
      Option.toArray(
        Option.map(
          configured,
          (held) => new LlmProviderSummary({ provider, credential: credentialKind(held) }),
        ),
      );
    return new LlmProviderList({
      providers: [...listed("anthropic", anthropic), ...listed("openai", openai)],
    });
  }
}

/**
 * Middleware that requires the admin token as a bearer token on every admin request, and
 * responds with 401 otherwise. Clients add the header themselves, for example with
 * `HttpClientRequest.bearerToken`.
 */
export class AdminAuthorization extends HttpApiMiddleware.Service<AdminAuthorization>()(
  "@usine/gateway/AdminAuthorization",
  { error: HttpApiError.Unauthorized, security: { bearer: HttpApiSecurity.bearer } },
) {}

/**
 * The admin API the executor uses to attach, renew, and detach a worker VM's GitHub credential
 * for an attempt, and to read the gateway's LLM provider credential kinds (ADR 0013).
 * Renewal re-creates a missing attachment under the same ID, so caller tokens stay valid.
 */
export const GatewayAdminApi = HttpApi.make("GatewayAdminApi").add(
  HttpApiGroup.make("attachments")
    .add(
      HttpApiEndpoint.post("attach", "/v1/attachments", {
        payload: AttachRequest,
        success: Attached,
        error: [
          AttachmentAlreadyExpired.annotate({ httpApiStatus: 422 }),
          AttachmentPersistenceError.annotate({ httpApiStatus: 503 }),
        ],
      }),
      HttpApiEndpoint.put("renew", "/v1/attachments/:id", {
        params: { id: AttachmentId },
        payload: AttachRequest,
        success: Attached,
        error: [
          AttachmentAlreadyExpired.annotate({ httpApiStatus: 422 }),
          AttachmentConflict.annotate({ httpApiStatus: 409 }),
          AttachmentPersistenceError.annotate({ httpApiStatus: 503 }),
        ],
      }),
      HttpApiEndpoint.delete("detach", "/v1/attachments/:id", {
        params: { id: AttachmentId },
        success: Detached,
        error: AttachmentPersistenceError.annotate({ httpApiStatus: 503 }),
      }),
      HttpApiEndpoint.get("list", "/v1/attachments", { success: AttachmentList }),
    )
    .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
    .middleware(AdminAuthorization),
  HttpApiGroup.make("llm")
    .add(HttpApiEndpoint.get("providers", "/v1/providers", { success: LlmProviderList }))
    .middleware(AdminAuthorization),
);
