import { Layer } from "effect";
import { Attachments } from "./attachment/store.ts";
import { CallerTokens } from "./caller/caller.ts";
import { ChatGptLogins } from "./chatgpt/logins.ts";
import { SettingsInForce } from "./settings.ts";

export { adminRoutes } from "./admin/server.ts";
export {
  AnonymousCredential,
  Attachment,
  AttachmentAlreadyExpired,
  AttachmentConflict,
  AttachmentPersistenceError,
  AttachmentCredential,
  AttachmentId,
  type AttachmentLookup,
  ExpiredAttachment,
  InstallationCredential,
  LiveAttachment,
  MissingAttachment,
} from "./attachment/attachment.ts";
export { Attachments, type AttachmentPersistence } from "./attachment/store.ts";
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
export { ChatGptAuthFileError, ChatGptTokens } from "./chatgpt/auth-file.ts";
export { CHATGPT_TOKEN_URL, ChatGptLoginUnavailable, ChatGptLogins } from "./chatgpt/logins.ts";
export {
  AnthropicApiKey,
  AnthropicCredential,
  AnthropicProvider,
  AnthropicSubscriptionToken,
  type ChatGptAccess,
  ChatGptLogin,
  HostFilePath,
  type LlmProvider,
  type LlmProviders,
  OpenAiApiKey,
  OpenAiCredential,
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
 * the current settings, and the ChatGPT logins. Provide this layer once to the reverse proxy,
 * forward proxy, admin API, and reload. The logins need a `FileSystem` for their auth files and
 * an `HttpClient` for refreshes.
 */
export const gatewayServicesWithAttachments = <E, R>(attachments: Layer.Layer<Attachments, E, R>) =>
  Layer.mergeAll(attachments, CallerTokens.layer, SettingsInForce.layer, ChatGptLogins.layer);

/** Shared gateway services with an in-memory attachment store. */
export const gatewayServices = gatewayServicesWithAttachments(Attachments.layer);
