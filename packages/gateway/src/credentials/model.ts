import { Schema } from "effect";
import { LlmProviderName } from "../llm/llm.ts";

const Secret = Schema.Redacted(Schema.NonEmptyString);
export const ProviderCredential = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("claude-subscription"), secret: Secret }),
  Schema.Struct({ kind: Schema.Literal("anthropic-api-key"), secret: Secret }),
  Schema.Struct({ kind: Schema.Literal("chatgpt-subscription"), secret: Secret }),
  Schema.Struct({ kind: Schema.Literal("openai-api-key"), secret: Secret }),
]);
export type ProviderCredential = typeof ProviderCredential.Type;
export const credentialProvider = (credential: ProviderCredential): LlmProviderName =>
  credential.kind === "claude-subscription" || credential.kind === "anthropic-api-key"
    ? "anthropic-messages"
    : "openai-responses";

export class ProviderCredentialError extends Schema.TaggedError<
  ProviderCredentialError,
  { readonly brand: unique symbol }
>()("ProviderCredentialError", { message: Schema.String }) {}

export const ProviderConnection = Schema.Struct({
  provider: LlmProviderName,
  credential: Schema.NullOr(Schema.Literals(["api-key", "subscription"])),
  expiresAt: Schema.NullOr(Schema.String),
  lastRefresh: Schema.NullOr(Schema.String),
});
export type ProviderConnection = typeof ProviderConnection.Type;
export const ProviderConnections = Schema.Struct({ providers: Schema.Array(ProviderConnection) });
/** A provider whose status could not be read on its destination, such as a missing harness. */
const ProviderUnavailable = Schema.Struct({ provider: LlmProviderName, error: Schema.String });

export const LoginProvider = Schema.Literals(["claude", "chatgpt"]);
export type LoginProvider = typeof LoginProvider.Type;
export const loginLlmProvider = (provider: LoginProvider): LlmProviderName =>
  provider === "claude" ? "anthropic-messages" : "openai-responses";
export const ProviderLoginState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("starting") }),
  Schema.Struct({
    status: Schema.Literal("authorizing"),
    url: Schema.String,
    code: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("connected") }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
  Schema.Struct({ status: Schema.Literal("cancelled") }),
]);
export type ProviderLoginState = typeof ProviderLoginState.Type;
export const ProviderLoginView = Schema.Struct({
  id: Schema.String,
  target: Schema.String,
  provider: LoginProvider,
  state: ProviderLoginState,
});
export type ProviderLoginView = typeof ProviderLoginView.Type;
export const ProviderTarget = Schema.Struct({
  target: Schema.String,
  label: Schema.String,
  providers: Schema.Array(Schema.Union([ProviderConnection, ProviderUnavailable])),
});
export type ProviderTarget = typeof ProviderTarget.Type;
export const ProviderStatus = Schema.Struct({
  targets: Schema.Array(
    Schema.Union([
      ProviderTarget,
      Schema.Struct({ target: Schema.String, label: Schema.String, error: Schema.String }),
    ]),
  ),
  logins: Schema.Array(ProviderLoginView),
});
export type ProviderStatus = typeof ProviderStatus.Type;
