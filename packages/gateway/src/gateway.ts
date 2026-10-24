import { Layer } from "effect";
import { Attachments } from "./attachment/store.ts";
import { CallerTokens } from "./caller/caller.ts";
import { SettingsInForce } from "./settings.ts";

export { adminRoutes } from "./admin/server.ts";
export {
  AnonymousCredential,
  Attachment,
  AttachmentAlreadyExpired,
  AttachmentConflict,
  AttachmentCredential,
  AttachmentId,
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
export { GatewayDomain } from "@usine/core/worker";
export {
  AdminToken,
  CallerKey,
  GatewaySettings,
  gatewayHosts,
  type ReloadableSettings,
  SettingsInForce,
} from "./settings.ts";
export { UpstreamBase } from "./upstream.ts";

/**
 * The Gateway's shared state for one process: the attachment store, the caller token signer,
 * and the current settings. Provide this layer once to the reverse proxy, forward proxy, admin
 * API, and reload.
 */
export const gatewayServices = Layer.mergeAll(
  Attachments.layer,
  CallerTokens.layer,
  SettingsInForce.layer,
);
