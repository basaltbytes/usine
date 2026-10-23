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
} from "effect/unstable/httpapi";
import {
  type Attachment,
  AttachmentAlreadyExpired,
  AttachmentConflict,
  AttachmentCredential,
  AttachmentId,
} from "../attachment/attachment.ts";
import { CallerToken } from "../caller/caller.ts";
import {
  type AnthropicProvider,
  credentialKind,
  LlmProviderName,
  type LlmProviders,
  type OpenAiProvider,
} from "../llm/llm.ts";

export { AttachmentId, InstallationCredential } from "../attachment/attachment.ts";
export { CallerToken, GATEWAY_TOKEN_HEADER } from "../caller/caller.ts";

/** What the executor attaches: one Attempt's credential for one Worker and repository, until it expires. */
export class AttachRequest extends Schema.Class<AttachRequest>("@usine/gateway/AttachRequest")({
  worker: WorkerName,
  repository: RepositoryName,
  credential: AttachmentCredential,
  expiresAt: Schema.DateTimeUtc,
}) {}

/** An attachment as the admin API reports it: everything but the token itself. */
export class AttachmentSummary extends Schema.Class<AttachmentSummary>(
  "@usine/gateway/AttachmentSummary",
)({
  id: AttachmentId,
  worker: WorkerName,
  repository: RepositoryName,
  credential: Schema.Literals(["InstallationCredential", "AnonymousCredential"]),
  expiresAt: Schema.DateTimeUtc,
}) {
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
 * The answer to an attach or a renewal: the attachment, and the caller token
 * the Worker VM presents for it. A renewal of the same attachment id answers
 * with the same token.
 */
export class Attached extends Schema.Class<Attached>("@usine/gateway/Attached")({
  attachment: AttachmentSummary,
  callerToken: CallerToken,
}) {}

/** The answer to a detach: whether the attachment existed. */
export class Detached extends Schema.Class<Detached>("@usine/gateway/Detached")({
  detached: Schema.Boolean,
}) {}

/** The attachments in force. */
export class AttachmentList extends Schema.Class<AttachmentList>("@usine/gateway/AttachmentList")({
  attachments: Schema.Array(AttachmentSummary),
}) {}

/** An LLM provider the gateway holds a credential for, with the kind of that credential and never the credential itself. */
export class LlmProviderSummary extends Schema.Class<LlmProviderSummary>(
  "@usine/gateway/LlmProviderSummary",
)({
  provider: LlmProviderName,
  credential: GatewayCredentialKind,
}) {}

/**
 * The LLM providers the gateway forwards to now, each with the kind of
 * credential it sends. A provider without a credential is absent, since the
 * gateway refuses its requests.
 */
export class LlmProviderList extends Schema.Class<LlmProviderList>(
  "@usine/gateway/LlmProviderList",
)({
  providers: Schema.Array(LlmProviderSummary),
}) {
  static fromProviders({ anthropic, openai }: LlmProviders): LlmProviderList {
    const listed = (
      provider: LlmProviderName,
      configured: Option.Option<AnthropicProvider | OpenAiProvider>,
    ) =>
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
 * Requires the gateway's admin token as a bearer token on every admin
 * request; a missing or different token is answered with 401. Clients add the
 * header themselves, for example with `HttpClientRequest.bearerToken`.
 */
export class AdminAuthorization extends HttpApiMiddleware.Service<AdminAuthorization>()(
  "@usine/gateway/AdminAuthorization",
  { error: HttpApiError.Unauthorized, security: { bearer: HttpApiSecurity.bearer } },
) {}

const strict = { parseOptions: { onExcessProperty: "error" } } as const;

/**
 * The API the executor calls to attach a GitHub credential to a Worker VM for
 * one repository at the start of an Attempt, renew it with the same id before
 * the token expires, and detach it at cleanup. Attachments are in memory:
 * after a gateway restart the executor's next renewal stores the attachment
 * again under its id, so the Attempt's caller token stays valid. The executor
 * also reads which LLM providers the gateway pays for and with which kind of
 * credential, so usage reports a Worker's children in the pool that pays
 * (ADR 0013).
 */
export const GatewayAdminApi = HttpApi.make("GatewayAdminApi").add(
  HttpApiGroup.make("attachments")
    .add(
      HttpApiEndpoint.post("attach", "/v1/attachments", {
        payload: AttachRequest.annotate(strict),
        success: Attached,
        error: AttachmentAlreadyExpired.annotate({ httpApiStatus: 422 }),
      }),
      HttpApiEndpoint.put("renew", "/v1/attachments/:id", {
        params: { id: AttachmentId },
        payload: AttachRequest.annotate(strict),
        success: Attached,
        error: [
          AttachmentAlreadyExpired.annotate({ httpApiStatus: 422 }),
          AttachmentConflict.annotate({ httpApiStatus: 409 }),
        ],
      }),
      HttpApiEndpoint.delete("detach", "/v1/attachments/:id", {
        params: { id: AttachmentId },
        success: Detached,
      }),
      HttpApiEndpoint.get("list", "/v1/attachments", { success: AttachmentList }),
    )
    .middleware(AdminAuthorization),
  HttpApiGroup.make("llm")
    .add(HttpApiEndpoint.get("providers", "/v1/providers", { success: LlmProviderList }))
    .middleware(AdminAuthorization),
);
