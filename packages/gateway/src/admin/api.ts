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

/** A request to attach one Attempt's credential for one Worker and repository until it expires. */
export class AttachRequest extends Schema.Class<AttachRequest>("@usine/gateway/AttachRequest")({
  worker: WorkerName,
  repository: RepositoryName,
  credential: AttachmentCredential,
  expiresAt: Schema.DateTimeUtc,
}) {}

/** An attachment without its token. */
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
 * The response to an attach or renew: the attachment and the Worker VM's caller token.
 * Renewing the same attachment ID returns the same token.
 */
export class Attached extends Schema.Class<Attached>("@usine/gateway/Attached")({
  attachment: AttachmentSummary,
  callerToken: CallerToken,
}) {}

/** The response to a detach. `detached` is whether the attachment existed. */
export class Detached extends Schema.Class<Detached>("@usine/gateway/Detached")({
  detached: Schema.Boolean,
}) {}

export class AttachmentList extends Schema.Class<AttachmentList>("@usine/gateway/AttachmentList")({
  attachments: Schema.Array(AttachmentSummary),
}) {}

/** An LLM provider the Gateway has a credential for, with the credential kind but not the credential. */
export class LlmProviderSummary extends Schema.Class<LlmProviderSummary>(
  "@usine/gateway/LlmProviderSummary",
)({
  provider: LlmProviderName,
  credential: GatewayCredentialKind,
}) {}

/** The LLM providers the Gateway forwards to, with each credential kind. Providers without a credential aren't listed. */
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
 * Middleware that requires the admin token as a bearer token on every admin request, and
 * responds with 401 otherwise. Clients add the header themselves, for example with
 * `HttpClientRequest.bearerToken`.
 */
export class AdminAuthorization extends HttpApiMiddleware.Service<AdminAuthorization>()(
  "@usine/gateway/AdminAuthorization",
  { error: HttpApiError.Unauthorized, security: { bearer: HttpApiSecurity.bearer } },
) {}

const strict = { parseOptions: { onExcessProperty: "error" } } as const;

/**
 * The admin API the executor uses to attach, renew, and detach a Worker VM's GitHub credential
 * for an Attempt, and to read the Gateway's LLM provider credential kinds (ADR 0013).
 * Attachments are in memory; after a Gateway restart, the executor's next renewal re-creates
 * each one under the same ID, so caller tokens stay valid.
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
