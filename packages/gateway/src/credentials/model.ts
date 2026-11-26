import {
  anthropic,
  GatewaySlot,
  type ModelProvider,
  type ModelProviderCatalog,
  ModelProviderId,
  openai,
  SubscriptionLogin,
} from "@usine/core/agent/provider";
import { type Brand, Option, Schema, SchemaTransformation } from "effect";

const Secret = Schema.Redacted(Schema.NonEmptyString);

/** A static key for the provider whose ID is `provider`. */
export class StaticKey extends Schema.TaggedClass<
  StaticKey,
  Brand.Brand<"@usine/gateway/credentials/model/StaticKey">
>()("StaticKey", {
  provider: ModelProviderId,
  secret: Secret,
}) {
  /** Returns the provider of `catalog` with this key's ID, if it accepts a static key. */
  providerIn(catalog: ModelProviderCatalog): Option.Option<ModelProvider> {
    return Option.filter(catalog.get(this.provider), (provider) => provider.accepts("api-key"));
  }
}

/**
 * A subscription login's secret: a `claude setup-token` token for `claude`, or the text of a Codex
 * `auth.json` with a ChatGPT login for `chatgpt`. The logins are a closed set, because the gateway
 * and the server implement each one's sign-in and refresh.
 */
export class LoginSecret extends Schema.TaggedClass<
  LoginSecret,
  Brand.Brand<"@usine/gateway/credentials/model/LoginSecret">
>()("LoginSecret", {
  login: SubscriptionLogin,
  secret: Secret,
}) {
  /** Returns the provider of `catalog` whose subscription signs in with this login. */
  providerIn(catalog: ModelProviderCatalog): Option.Option<ModelProvider> {
    return catalog.signingIn(this.login);
  }
}

const StaticKeyKind = Schema.Struct({
  kind: Schema.TemplateLiteralParser([Schema.String, "-api-key"]),
  secret: Secret,
}).pipe(
  Schema.decodeTo(
    StaticKey,
    SchemaTransformation.transform({
      decode: ({ kind: [provider], secret }) => ({ _tag: "StaticKey" as const, provider, secret }),
      encode: ({ provider, secret }) => ({ kind: [provider, "-api-key"] as const, secret }),
    }),
  ),
);

const LoginKind = Schema.Struct({
  kind: Schema.TemplateLiteralParser([SubscriptionLogin, "-subscription"]),
  secret: Secret,
}).pipe(
  Schema.decodeTo(
    LoginSecret,
    SchemaTransformation.transform({
      decode: ({ kind: [login], secret }) => ({ _tag: "LoginSecret" as const, login, secret }),
      encode: ({ login, secret }) => ({ kind: [login, "-subscription"] as const, secret }),
    }),
  ),
);

/**
 * A credential that usine connects on a destination, encoded as `{ kind, secret }`: the kind of a
 * static key is `<provider ID>-api-key`, and the kind of a login `claude-subscription` or
 * `chatgpt-subscription`. Gateways up to 0.3.0 accept the kinds of the built-in providers.
 */
export const ProviderCredential = Schema.Union([StaticKeyKind, LoginKind]);
export type ProviderCredential = typeof ProviderCredential.Type;

export class ProviderCredentialError extends Schema.TaggedError<
  ProviderCredentialError,
  { readonly brand: unique symbol }
>()("ProviderCredentialError", { message: Schema.String }) {}

/** The error when the gateway's catalog has no provider by a name, or none that accepts a credential. */
export class UnservedProvider extends Schema.TaggedError<
  UnservedProvider,
  Brand.Brand<"@usine/gateway/credentials/model/UnservedProvider">
>()("UnservedProvider", {
  /** The provider's ID or slot, or the subscription login, that the request named. */
  provider: Schema.String,
  message: Schema.String,
}) {}

/** The credentials that a provider accepts on a destination. */
export const AcceptedCredentials = Schema.Struct({
  apiKey: Schema.Boolean,
  /** The subscription login that the provider accepts, or `null`. */
  login: Schema.NullOr(SubscriptionLogin),
});
export type AcceptedCredentials = typeof AcceptedCredentials.Type;

const entryFields = {
  id: ModelProviderId,
  /** The provider's display name, such as `Anthropic`. */
  label: Schema.NonEmptyString,
  accepts: AcceptedCredentials,
};

const connectionFields = {
  provider: GatewaySlot,
  credential: Schema.NullOr(Schema.Literals(["api-key", "subscription"])),
  expiresAt: Schema.NullOr(Schema.String),
  lastRefresh: Schema.NullOr(Schema.String),
  /** Omitted when the destination does not report whether the credential can refresh. */
  refreshable: Schema.optionalKey(Schema.Boolean),
};

/** Returns the ID, display name, and accepted credentials of `provider`, as a destination lists them. */
export const providerEntry = (provider: ModelProvider) => ({
  id: provider.id,
  label: provider.label,
  accepts: { apiKey: provider.accepts("api-key"), login: Option.getOrNull(provider.login) },
});

/** A provider that a destination lists, and the state of its credential there. */
export const ProviderConnection = Schema.Struct({ ...connectionFields, ...entryFields });
export type ProviderConnection = typeof ProviderConnection.Type;

/**
 * The slots that orchestrators from before the provider catalog decode in a report's `providers`;
 * any other slot there fails their whole read.
 */
export const SLOTS_BEFORE_CATALOG: ReadonlyArray<GatewaySlot> = [anthropic.slot, openai.slot];

/**
 * The state of the credential in each slot of the gateway's catalog, with the slot's provider.
 * `catalog` lists every slot. `providers` lists the slots that orchestrators up to 0.6.0 decode,
 * those of `SLOTS_BEFORE_CATALOG`, so another slot doesn't fail their read. Gateways up to 0.3.0
 * omit `catalog` and report only the state in `providers`.
 */
export const ProviderConnections = Schema.Struct({
  providers: Schema.Array(Schema.Union([ProviderConnection, Schema.Struct(connectionFields)])),
  catalog: Schema.optionalKey(Schema.Array(ProviderConnection)),
});
export type ProviderConnections = typeof ProviderConnections.Type;

/** Returns the report of `connections`, every slot of the gateway's catalog in catalog order. */
export const connectionsReport = (
  connections: ReadonlyArray<ProviderConnection>,
): ProviderConnections => ({
  providers: connections.filter(({ provider }) => SLOTS_BEFORE_CATALOG.includes(provider)),
  catalog: connections,
});

/** Returns every slot that `report` lists, from `catalog` when the gateway reports it. */
export const reportedConnections = (report: ProviderConnections) =>
  report.catalog ?? report.providers;

/** A provider whose status could not be read on its destination, such as a missing harness. */
const ProviderUnavailable = Schema.Struct({
  provider: GatewaySlot,
  ...entryFields,
  error: Schema.String,
});

/** A subscription login that usine signs in on a target. */
export const LoginProvider = SubscriptionLogin;
export type LoginProvider = SubscriptionLogin;

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
