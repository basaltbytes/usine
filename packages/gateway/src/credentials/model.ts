import {
  anthropic,
  type GatewaySlot,
  GatewaySlot as GatewaySlotSchema,
  type ModelProvider,
  openai,
  SubscriptionLogin,
} from "@usine/core/agent/provider";
import { Schema } from "effect";

const Secret = Schema.Redacted(Schema.NonEmptyString);
export const ProviderCredential = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("claude-subscription"), secret: Secret }),
  Schema.Struct({ kind: Schema.Literal("anthropic-api-key"), secret: Secret }),
  Schema.Struct({ kind: Schema.Literal("chatgpt-subscription"), secret: Secret }),
  Schema.Struct({ kind: Schema.Literal("openai-api-key"), secret: Secret }),
]);
export type ProviderCredential = typeof ProviderCredential.Type;

/** The provider that accepts each kind of `ProviderCredential`. */
const PROVIDER_OF_KIND = {
  "claude-subscription": anthropic,
  "anthropic-api-key": anthropic,
  "chatgpt-subscription": openai,
  "openai-api-key": openai,
} as const satisfies Record<ProviderCredential["kind"], ModelProvider>;

/** The provider whose subscription credential signs in with each login. */
const PROVIDER_OF_LOGIN = {
  claude: anthropic,
  chatgpt: openai,
} as const satisfies Record<SubscriptionLogin, ModelProvider>;

/** Returns the slot of the provider that accepts `credential`. */
export const credentialProvider = (credential: ProviderCredential): GatewaySlot =>
  PROVIDER_OF_KIND[credential.kind].slot;

export class ProviderCredentialError extends Schema.TaggedError<
  ProviderCredentialError,
  { readonly brand: unique symbol }
>()("ProviderCredentialError", { message: Schema.String }) {}

export const ProviderConnection = Schema.Struct({
  provider: GatewaySlotSchema,
  credential: Schema.NullOr(Schema.Literals(["api-key", "subscription"])),
  expiresAt: Schema.NullOr(Schema.String),
  lastRefresh: Schema.NullOr(Schema.String),
  /** Omitted when the destination does not report whether the credential can refresh. */
  refreshable: Schema.optionalKey(Schema.Boolean),
});
export type ProviderConnection = typeof ProviderConnection.Type;
export const ProviderConnections = Schema.Struct({ providers: Schema.Array(ProviderConnection) });
/** A provider whose status could not be read on its destination, such as a missing harness. */
const ProviderUnavailable = Schema.Struct({ provider: GatewaySlotSchema, error: Schema.String });

/** A subscription login that usine signs in on a target. */
export const LoginProvider = SubscriptionLogin;
export type LoginProvider = SubscriptionLogin;

/** Returns the slot of the provider whose subscription signs in with `login`. */
export const loginLlmProvider = (login: LoginProvider): GatewaySlot =>
  PROVIDER_OF_LOGIN[login].slot;
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
