import { Array as Arr, type Brand, Effect, Option, Schema, SchemaGetter } from "effect";
import type { GatewayCredentialKind } from "../../worker.ts";

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** A model provider's ID, such as `anthropic`. A provisioned worker's `api_keys` names providers by it. */
export const ModelProviderId = Schema.String.check(
  Schema.isPattern(KEBAB, { message: "Expected a kebab-case model provider ID" }),
).pipe(Schema.brand("ModelProviderId"));
export type ModelProviderId = typeof ModelProviderId.Type;

/**
 * The ID of a provider's slot at the gateway, such as `anthropic-messages`: the provider's
 * credential at the gateway, its `llm.<domain>` path prefix, and its name in `llm_providers`.
 */
export const GatewaySlot = Schema.String.check(
  Schema.isPattern(KEBAB, { message: "Expected a kebab-case gateway slot" }),
).pipe(Schema.brand("GatewaySlot"));
export type GatewaySlot = typeof GatewaySlot.Type;

/** A wire protocol's ID, such as `anthropic-messages` or `openai-responses`. */
export const WireProtocol = Schema.String.check(
  Schema.isPattern(KEBAB, { message: "Expected a kebab-case wire protocol" }),
).pipe(Schema.brand("WireProtocol"));
export type WireProtocol = typeof WireProtocol.Type;

/**
 * A path that a protocol serves under its provider's slot, such as `/v1/models/{model}`. A
 * placeholder in braces matches one segment of letters, digits, `.`, `_`, and `-` that starts with
 * a letter or digit, so a dot segment, an empty segment, or a percent-encoded separator never
 * matches.
 */
export const RoutePattern = Schema.String.check(
  Schema.isPattern(/^(?:\/(?:[A-Za-z0-9._~:-]|\{[a-z][A-Za-z0-9]*\})+)+$/u, {
    message: "Expected a route such as /v1/messages or /v1/models/{model}",
  }),
).pipe(Schema.brand("RoutePattern"));
export type RoutePattern = typeof RoutePattern.Type;

/** A request header's name in lowercase, such as `x-api-key`. */
export const HeaderName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u, { message: "Expected a lowercase header name" }),
).pipe(Schema.brand("HeaderName"));
export type HeaderName = typeof HeaderName.Type;

/** The name of an environment variable that the gateway reads, such as `ANTHROPIC_API_KEY`. */
export const GatewayVariable = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u, {
    message: "Expected an uppercase environment variable name",
  }),
).pipe(Schema.brand("GatewayVariable"));
export type GatewayVariable = typeof GatewayVariable.Type;

/** The base URL of an upstream API: scheme, host, and an optional path prefix, with no query, fragment, or trailing slash. */
export const UpstreamBase = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*[^/?#\s])?$/u, {
    message: "Expected an http(s) base URL without a query or a trailing slash",
  }),
).pipe(Schema.brand("UpstreamBase"));
export type UpstreamBase = typeof UpstreamBase.Type;

const PLACEHOLDER = /\{[a-z][A-Za-z0-9]*\}/gu;
const SEGMENT_TEXT = "[A-Za-z0-9][A-Za-z0-9._-]*";
const matchers = new Map<string, RegExp>();

/** Returns the expression that matches the paths of `route`, compiled once. */
const matcherOf = (route: RoutePattern): RegExp => {
  const known = matchers.get(route);
  if (known !== undefined) return known;
  const literal = route
    .split(PLACEHOLDER)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&"));
  const compiled = new RegExp(`^${literal.join(SEGMENT_TEXT)}$`, "u");
  matchers.set(route, compiled);
  return compiled;
};

/** Returns whether `path`, a path without its query, is one that `route` serves. */
export const routeServes = (route: RoutePattern, path: string): boolean =>
  matcherOf(route).test(path);

/** Where a static key goes in a request: in `header`, after `Bearer ` with `bearer`, or alone with `none`. */
export class KeyHeader extends Schema.Class<
  KeyHeader,
  Brand.Brand<"@usine/core/agent/provider/KeyHeader">
>("Agent/KeyHeader")({
  header: HeaderName,
  scheme: Schema.Literals(["bearer", "none"]),
}) {
  /** Returns the header value that carries `key`. */
  value(key: string): string {
    return this.scheme === "bearer" ? `Bearer ${key}` : key;
  }
}

/** A wire protocol that a provider serves: its upstream, its routes, and where its key goes. */
export class ProviderProtocol extends Schema.Class<
  ProviderProtocol,
  Brand.Brand<"@usine/core/agent/provider/ProviderProtocol">
>("Agent/ProviderProtocol")({
  protocol: WireProtocol,
  /** The base URL to which the gateway appends a route's path. */
  upstream: UpstreamBase,
  /** The paths under the provider's slot that the protocol serves; other paths are refused. */
  routes: Schema.NonEmptyArray(RoutePattern).check(Schema.isUnique()),
  key: KeyHeader,
}) {
  /** Returns whether `path`, a path under the slot without its query, is one of the routes. */
  serves(path: string): boolean {
    return this.routes.some((route) => routeServes(route, path));
  }
}

/** The subscription logins whose sign-in and refresh the gateway implements. */
export const SubscriptionLogin = Schema.Literals(["claude", "chatgpt"]);
export type SubscriptionLogin = typeof SubscriptionLogin.Type;

/** A static key, which the gateway reads from `variable` and sends in each protocol's key header. */
export class ApiKeyCredential extends Schema.TaggedClass<
  ApiKeyCredential,
  Brand.Brand<"@usine/core/agent/provider/ApiKeyCredential">
>("Agent/ApiKeyCredential")("ApiKey", {
  variable: GatewayVariable,
}) {}

/**
 * A subscription login, which the gateway reads from `variable` and signs in and refreshes as
 * `login` does: `claude` reads a `claude setup-token` token, and `chatgpt` the path of a Codex
 * `auth.json`.
 */
export class SubscriptionCredential extends Schema.TaggedClass<
  SubscriptionCredential,
  Brand.Brand<"@usine/core/agent/provider/SubscriptionCredential">
>("Agent/SubscriptionCredential")("Subscription", {
  login: SubscriptionLogin,
  variable: GatewayVariable,
}) {}

/** A credential that a provider accepts at the gateway. */
export const AcceptedCredential = Schema.Union([ApiKeyCredential, SubscriptionCredential]);
export type AcceptedCredential = typeof AcceptedCredential.Type;

const kindOf = (credential: AcceptedCredential): GatewayCredentialKind =>
  credential._tag === "ApiKey" ? "api-key" : "subscription";

/**
 * A model provider: its slot at the gateway, the wire protocols that the slot serves, and the
 * credentials it accepts. Paths under the slot map to the protocol that serves them, so one
 * credential can serve several protocols, each with its own upstream and key header.
 */
export class ModelProvider extends Schema.Class<
  ModelProvider,
  Brand.Brand<"@usine/core/agent/provider/ModelProvider">
>("Agent/ModelProvider")(
  Schema.Struct({
    id: ModelProviderId,
    /** The slot at the gateway, which is usually the provider ID. */
    slot: GatewaySlot,
    /** The display name, such as `Anthropic`. */
    label: Schema.NonEmptyString,
    protocols: Schema.NonEmptyArray(ProviderProtocol),
    credentials: Schema.NonEmptyArray(AcceptedCredential),
    /**
     * The request headers that pass to the upstream besides the content headers, or `None` to pass
     * every header except hop-by-hop and credential headers.
     */
    passThrough: Schema.Option(Schema.Array(HeaderName)).pipe(
      Schema.withConstructorDefault(Effect.succeedNone),
    ),
    /** The gateway variable that replaces the upstream of each of the provider's protocols. */
    upstreamVariable: Schema.Option(GatewayVariable).pipe(
      Schema.withConstructorDefault(Effect.succeedNone),
    ),
  }).check(
    Schema.makeFilter(
      ({ protocols }) =>
        new Set(protocols.map(({ protocol }) => protocol)).size === protocols.length ||
        "A provider serves each protocol once",
    ),
    Schema.makeFilter(({ protocols }) => {
      const routes = protocols.flatMap(({ routes }) => routes);
      return new Set(routes).size === routes.length || "A route belongs to one protocol";
    }),
    Schema.makeFilter(
      ({ credentials }) =>
        new Set(credentials.map(kindOf)).size === credentials.length ||
        "A provider accepts at most one credential of each kind",
    ),
  ),
) {
  /** The credential kinds that the provider accepts. */
  get kinds(): ReadonlyArray<GatewayCredentialKind> {
    return this.credentials.map(kindOf);
  }

  /** Returns whether the provider accepts a credential of `kind`. */
  accepts(kind: GatewayCredentialKind): boolean {
    return this.kinds.includes(kind);
  }

  /** Returns the credential of `kind` that the provider accepts, if any. */
  credential(kind: GatewayCredentialKind): Option.Option<AcceptedCredential> {
    return Arr.findFirst(this.credentials, (credential) => kindOf(credential) === kind);
  }

  /** Returns the protocol that serves `path`, a path under the slot without its query. */
  protocolFor(path: string): Option.Option<ProviderProtocol> {
    return Arr.findFirst(this.protocols, (protocol) => protocol.serves(path));
  }

  /** Every route under the slot, in protocol order. */
  get routes(): ReadonlyArray<RoutePattern> {
    return this.protocols.flatMap(({ routes }) => routes);
  }

  /** The hosts of the provider's upstreams. */
  get hosts(): ReadonlyArray<string> {
    return Arr.dedupe(this.protocols.map(({ upstream }) => new URL(upstream).hostname));
  }
}

const namesOf = ({ id, slot }: ModelProvider): ReadonlyArray<string> => {
  const names: ReadonlyArray<string> = [id, slot];
  return Arr.dedupe(names);
};

/**
 * Model providers whose IDs and slots are all distinct, so a name finds one provider. Configuration
 * accepts a provider ID wherever it accepts a slot.
 */
export class ModelProviderCatalog extends Schema.Class<
  ModelProviderCatalog,
  Brand.Brand<"@usine/core/agent/provider/ModelProviderCatalog">
>("Agent/ModelProviderCatalog")(
  Schema.Struct({ providers: Schema.Array(ModelProvider) }).check(
    Schema.makeFilter(({ providers }) => {
      const names = providers.flatMap(namesOf);
      return new Set(names).size === names.length || "Each provider ID and slot names one provider";
    }),
  ),
) {
  /** Every slot, in catalog order. */
  get slots(): ReadonlyArray<GatewaySlot> {
    return this.providers.map(({ slot }) => slot);
  }

  /** Returns the provider whose slot or ID is `name`. */
  find(name: string): Option.Option<ModelProvider> {
    return Arr.findFirst(this.providers, (provider) => namesOf(provider).includes(name));
  }

  /** Returns the provider whose ID is `id`. */
  get(id: string): Option.Option<ModelProvider> {
    return Arr.findFirst(this.providers, (provider) => provider.id === id);
  }

  /** Decodes a slot, or a provider ID as configurations from before slots wrote it, to the slot. */
  get slotFromName() {
    const known = Schema.String.check(
      Schema.makeFilter(
        (name) =>
          Option.isSome(this.find(name)) ||
          `Unknown provider "${name}". Choose ${this.slots.join(", ")}.`,
      ),
    );
    return known.pipe(
      Schema.decodeTo(GatewaySlot, {
        decode: SchemaGetter.transform((name: string): string =>
          Option.match(this.find(name), { onNone: () => name, onSome: ({ slot }) => slot }),
        ),
        encode: SchemaGetter.transform((slot: string) => slot),
      }),
    );
  }

  /** A provider ID of the catalog. */
  get providerId() {
    return ModelProviderId.check(
      Schema.makeFilter(
        (id) =>
          Option.isSome(this.get(id)) ||
          `Unknown provider "${id}". Choose ${this.providers.map((provider) => provider.id).join(", ")}.`,
      ),
    );
  }
}
