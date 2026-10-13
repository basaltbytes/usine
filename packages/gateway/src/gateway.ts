import { Layer } from "effect";
import { Attachments } from "./attachment/store.ts";
import { CallerTokens } from "./caller/caller.ts";

export { adminRoutes } from "./admin/server.ts";
export {
  AnonymousCredential,
  Attachment,
  AttachmentAlreadyExpired,
  AttachmentCredential,
  type AttachmentLookup,
  ExpiredAttachment,
  InstallationCredential,
  LiveAttachment,
  MissingAttachment,
} from "./attachment/attachment.ts";
export { Attachments } from "./attachment/store.ts";
export {
  CallerClaims,
  CallerToken,
  CallerTokenRejected,
  CallerTokens,
  GATEWAY_TOKEN_HEADER,
  tokenFromAuthorization,
} from "./caller/caller.ts";
export {
  type EgressDecision,
  EgressAllowlist,
  EgressAllowlistError,
  EgressPermitted,
  EgressRefusalReason,
  EgressRefused,
  EgressRule,
  HostName,
  parseEgressAllowlist,
  Port,
} from "./egress/egress.ts";
export { GITHUB_ORIGINS, type GitHubOrigins } from "./github/github.ts";
export {
  AnthropicApiKey,
  AnthropicCredential,
  AnthropicProvider,
  AnthropicSubscriptionToken,
  type LlmProviders,
  OpenAiProvider,
} from "./llm/llm.ts";
export { endToEndHeaders } from "./proxy/forward.ts";
export { GatewayProxy, REFUSAL_HEADER, RefusalReason } from "./proxy/proxy.ts";
export { AdminToken, CallerKey, GatewayDomain, GatewaySettings, gatewayHosts } from "./settings.ts";
export { UpstreamBase } from "./upstream.ts";

/**
 * The gateway's shared state for one process: the attachment store and the
 * caller token signer. The reverse proxy and the admin API must use the same
 * instance, so provide this layer once to both.
 */
export const gatewayServices = Layer.mergeAll(Attachments.layer, CallerTokens.layer);
