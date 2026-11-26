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
 * matches. A route has no `.` or `..` segment, and a literal separates two placeholders in one
 * segment.
 */
export const RoutePattern = Schema.String.check(
  Schema.isPattern(/^(?:\/(?:[A-Za-z0-9._~:-]|\{[a-z][A-Za-z0-9]*\})+)+$/u, {
    message: "Expected a route such as /v1/messages or /v1/models/{model}",
  }),
  Schema.makeFilter(
    (route) =>
      !route.split("/").some((segment) => segment === "." || segment === "..") ||
      "Expected a route without a . or .. segment",
  ),
  Schema.makeFilter(
    (route) =>
      !route.includes("}{") || "Expected a literal between two placeholders in one segment",
  ),
).pipe(Schema.brand("RoutePattern"));
export type RoutePattern = typeof RoutePattern.Type;

/** A request header's name in lowercase, such as `x-api-key`. */
export const HeaderName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u, { message: "Expected a lowercase header name" }),
).pipe(Schema.brand("HeaderName"));
export type HeaderName = typeof HeaderName.Type;

/**
 * The request headers that apply to one connection or route a request (RFC 9110, section 7.6.1),
 * which a proxy never forwards.
 */
export const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
] as const;

/** The headers that a key can't go in: the hop-by-hop headers and those that frame a body. */
const UNKEYABLE_HEADERS: ReadonlyArray<string> = [
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length",
  "content-type",
];

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

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** The characters that a placeholder's first character can be. */
const PLACEHOLDER_FIRST = ALPHANUMERIC;
/** The characters that a placeholder's later characters can be. */
const PLACEHOLDER_REST = `${ALPHANUMERIC}._-`;

/** A route segment: each literal character, and `null` for each placeholder. */
type SegmentParts = ReadonlyArray<string | null>;

/** Each segment of `route`, the first being the empty one before its leading `/`. */
const segmentsOf = (route: RoutePattern): ReadonlyArray<SegmentParts> =>
  route
    .split("/")
    .map((segment) =>
      segment
        .split(PLACEHOLDER)
        .flatMap((literal, index) => [...(index === 0 ? [] : [null]), ...literal]),
    );

/**
 * Returns the steps from `state` in `parts`: the characters that the next one can be, as a string,
 * and the state it reaches. State `2 * i` is before part `i`, and `2 * i + 1` is inside the
 * placeholder at part `i`.
 */
const steps = (parts: SegmentParts, state: number): ReadonlyArray<readonly [string, number]> => {
  if (state % 2 === 1) return [[PLACEHOLDER_REST, state]];
  const part = parts[state / 2];
  if (part === undefined) return [];
  return part === null ? [[PLACEHOLDER_FIRST, state + 1]] : [[part, state + 2]];
};

/** Returns `state` and the state after the placeholder that it is inside, if any. */
const settled = (state: number): ReadonlyArray<number> =>
  state % 2 === 1 ? [state, state + 1] : [state];

/**
 * Returns whether `text`, one segment of a path, matches `parts`, in time linear in its length: the
 * walk keeps the set of states that the characters read so far reach.
 */
const segmentMatches = (parts: SegmentParts, text: string): boolean => {
  let states = settled(0);
  for (const character of text) {
    states = Arr.dedupe(
      states.flatMap((state) =>
        steps(parts, state).flatMap(([expected, next]) =>
          expected.includes(character) ? settled(next) : [],
        ),
      ),
    );
    if (states.length === 0) return false;
  }
  return states.includes(2 * parts.length);
};

/** Returns whether `path`, a path without its query, matches the segments of a route. */
const routeMatches = (segments: ReadonlyArray<SegmentParts>, path: string): boolean => {
  const texts = path.split("/");
  return (
    texts.length === segments.length &&
    segments.every((parts, index) => segmentMatches(parts, texts[index] ?? ""))
  );
};

/**
 * Returns whether one string matches both `left` and `right`, two route segments, by walking every
 * pair of states that a common prefix reaches.
 */
const segmentsOverlap = (left: SegmentParts, right: SegmentParts): boolean => {
  const seen = new Set<string>();
  const pending: Array<readonly [number, number]> = [[0, 0]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop())
    for (const leftState of settled(pair[0]))
      for (const rightState of settled(pair[1])) {
        const key = `${String(leftState)},${String(rightState)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (leftState === 2 * left.length && rightState === 2 * right.length) return true;
        for (const [leftCharacter, leftNext] of steps(left, leftState))
          for (const [rightCharacter, rightNext] of steps(right, rightState))
            if ([...leftCharacter].some((character) => rightCharacter.includes(character)))
              pending.push([leftNext, rightNext]);
      }
  return false;
};

/** Returns whether a path matches both `left` and `right`. */
const routesOverlap = (left: RoutePattern, right: RoutePattern): boolean => {
  const leftSegments = segmentsOf(left);
  const rightSegments = segmentsOf(right);
  return (
    leftSegments.length === rightSegments.length &&
    leftSegments.every((parts, index) => segmentsOverlap(parts, rightSegments[index] ?? []))
  );
};

/** Where a static key goes in a request: in `header`, after `Bearer ` with `bearer`, or alone with `none`. */
export class KeyHeader extends Schema.Class<
  KeyHeader,
  Brand.Brand<"@usine/core/agent/provider/KeyHeader">
>("Agent/KeyHeader")({
  /** The header, which is neither hop-by-hop nor one that frames the body, such as `content-length`. */
  header: HeaderName.check(
    Schema.makeFilter(
      (header) =>
        !UNKEYABLE_HEADERS.includes(header) ||
        `Expected a key header other than ${UNKEYABLE_HEADERS.join(", ")}`,
    ),
  ),
  scheme: Schema.Literals(["bearer", "none"]),
}) {
  /** Returns the header value that carries `key`. */
  value(key: string): string {
    return this.scheme === "bearer" ? `Bearer ${key}` : key;
  }
}

/** An HTTP request method that a route accepts. */
export const RouteMethod = Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
export type RouteMethod = typeof RouteMethod.Type;

/** A wire protocol that a provider serves: its upstream, its routes, and where its key goes. */
export class ProviderProtocol extends Schema.Class<
  ProviderProtocol,
  Brand.Brand<"@usine/core/agent/provider/ProviderProtocol">
>("Agent/ProviderProtocol")(
  Schema.Struct({
    protocol: WireProtocol,
    /** The base URL to which the gateway appends a route's path. */
    upstream: UpstreamBase,
    /** The paths under the provider's slot that the protocol serves; other paths are refused. */
    routes: Schema.NonEmptyArray(RoutePattern).check(Schema.isUnique()),
    key: KeyHeader,
    /**
     * The methods that each route accepts, by route, or `None` for every method on every route.
     * The Cloudflare outbound handler refuses another method.
     */
    methods: Schema.Option(Schema.Record(RoutePattern, Schema.NonEmptyArray(RouteMethod))).pipe(
      Schema.withConstructorDefault(Effect.succeedNone),
    ),
  }).check(
    Schema.makeFilter(({ routes, methods }) =>
      Option.match(methods, {
        onNone: () => true,
        onSome: (byRoute) => {
          const listed = Object.keys(byRoute);
          return (
            (listed.length === routes.length && routes.every((route) => listed.includes(route))) ||
            "Expected the methods of each route and of no other path"
          );
        },
      }),
    ),
  ),
) {
  readonly #segments = this.routes.map(segmentsOf);

  /** Returns whether `path`, a path under the slot without its query, is one of the routes. */
  serves(path: string): boolean {
    return this.#segments.some((segments) => routeMatches(segments, path));
  }

  /** Returns whether `path` is one of the routes, and `method` one that the route accepts. */
  allows(method: string, path: string): boolean {
    return this.routes.some(
      (route, index) =>
        routeMatches(this.#segments[index] ?? [], path) &&
        Option.match(this.methods, {
          onNone: () => true,
          onSome: (byRoute) => (byRoute[route] ?? []).some((accepted) => accepted === method),
        }),
    );
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

/** The request headers that pass to every upstream that lists the headers it accepts. */
const CONTENT_HEADERS: ReadonlyArray<string> = [
  "accept",
  "accept-encoding",
  "content-encoding",
  "content-length",
  "content-type",
  "user-agent",
];

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
    Schema.makeFilter(
      ({ protocols }) =>
        !protocols.some((protocol, index) =>
          protocols
            .slice(index + 1)
            .some((other) =>
              protocol.routes.some((route) =>
                other.routes.some((otherRoute) => routesOverlap(route, otherRoute)),
              ),
            ),
        ) || "A path matches the routes of one protocol",
    ),
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

  /** The subscription login that the provider accepts, if any. */
  get login(): Option.Option<SubscriptionLogin> {
    return Arr.findFirst(this.credentials, (credential) =>
      credential._tag === "Subscription" ? Option.some(credential.login) : Option.none(),
    );
  }

  /**
   * Returns whether the request header `name`, in lowercase, passes to the provider's upstreams:
   * every header, or the content headers and the ones that `passThrough` lists.
   */
  passes(name: string): boolean {
    return Option.match(this.passThrough, {
      onNone: () => true,
      onSome: (listed) =>
        CONTENT_HEADERS.includes(name) || listed.some((header) => header === name),
    });
  }

  /** Returns the protocol that serves `path`, a path under the slot without its query. */
  protocolFor(path: string): Option.Option<ProviderProtocol> {
    return Arr.findFirst(this.protocols, (protocol) => protocol.serves(path));
  }

  /** Every route under the slot, in protocol order. */
  get routes(): ReadonlyArray<RoutePattern> {
    return this.protocols.flatMap(({ routes }) => routes);
  }

  /** The upstream that every protocol of the provider has, if they have the same one. */
  get sharedUpstream(): Option.Option<UpstreamBase> {
    const [first, ...rest] = this.protocols;
    return rest.every(({ upstream }) => upstream === first.upstream)
      ? Option.some(first.upstream)
      : Option.none();
  }

  /** The hosts of the provider's upstreams. */
  get hosts(): ReadonlyArray<string> {
    return Arr.dedupe(this.protocols.map(({ upstream }) => new URL(upstream).hostname));
  }
}

/** A path on `llm.<domain>`, split into the provider that its first segment names and the rest. */
export interface SlotTarget {
  readonly provider: ModelProvider;
  /** The path after the first segment, such as `/v1/messages`, or empty. */
  readonly rest: string;
  /** Whether the first segment is the provider ID, as before slots, instead of the slot. */
  readonly legacy: boolean;
}

const namesOf = ({ id, slot }: ModelProvider): ReadonlyArray<string> => {
  const names: ReadonlyArray<string> = [id, slot];
  return Arr.dedupe(names);
};

/** The names by which an operator selects a provider of a destination. */
export interface ProviderSelectors {
  readonly slot: string;
  readonly id: string;
  /** The subscription login that the provider accepts, if any. */
  readonly login: Option.Option<SubscriptionLogin>;
}

const selectorsOf = ({ slot, id, login }: ProviderSelectors): ReadonlyArray<string> =>
  Arr.dedupe([slot, id, ...Option.toArray(login)]);

/**
 * Returns the provider among `providers` that `name` selects by its slot, its ID, or the
 * subscription login it accepts, with `selectors` giving each provider's names. In a catalog each
 * name selects at most one provider; a name that selects several selects none.
 */
export const selectProvider = <A>(
  providers: ReadonlyArray<A>,
  name: string,
  selectors: (provider: A) => ProviderSelectors,
): Option.Option<A> => {
  const [first, ...rest] = providers.filter((provider) =>
    selectorsOf(selectors(provider)).includes(name),
  );
  return first === undefined || rest.length > 0 ? Option.none() : Option.some(first);
};

/** The gateway variables that `provider` reads: its credentials' and its upstream variable. */
const variablesOf = ({ credentials, upstreamVariable }: ModelProvider) =>
  Arr.dedupe([...credentials.map(({ variable }) => variable), ...Option.toArray(upstreamVariable)]);

/**
 * Model providers whose IDs, slots, and subscription logins are all distinct, so a name selects one
 * provider, and that read no gateway variable in common, so a key goes only to its own provider's
 * upstream. Configuration accepts a provider ID wherever it accepts a slot.
 */
export class ModelProviderCatalog extends Schema.Class<
  ModelProviderCatalog,
  Brand.Brand<"@usine/core/agent/provider/ModelProviderCatalog">
>("Agent/ModelProviderCatalog")(
  Schema.Struct({ providers: Schema.Array(ModelProvider) }).check(
    Schema.makeFilter(({ providers }) => {
      const names = providers.flatMap(selectorsOf);
      return (
        new Set(names).size === names.length ||
        "Each provider ID, slot, and subscription login names one provider"
      );
    }),
    Schema.makeFilter(({ providers }) => {
      const variables = providers.flatMap(variablesOf);
      return (
        new Set(variables).size === variables.length ||
        "Each gateway variable belongs to one provider"
      );
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

  /**
   * Returns the provider whose slot or ID is the first segment of `pathname`, and the rest of the
   * path. For example, `/anthropic-messages/v1/messages` is `/v1/messages` of the provider with
   * that slot.
   */
  target(pathname: string): Option.Option<SlotTarget> {
    const match = /^\/([a-z0-9-]+)(\/.*)?$/u.exec(pathname);
    if (match === null) return Option.none();
    const [, prefix = "", rest = ""] = match;
    return Option.map(this.find(prefix), (provider) => ({
      provider,
      rest,
      legacy: prefix !== provider.slot,
    }));
  }

  /** Returns the provider whose ID is `id`. */
  get(id: string): Option.Option<ModelProvider> {
    return Arr.findFirst(this.providers, (provider) => provider.id === id);
  }

  /** Returns the provider whose subscription signs in with `login`. */
  signingIn(login: SubscriptionLogin): Option.Option<ModelProvider> {
    return Arr.findFirst(this.providers, (provider) => Option.contains(provider.login, login));
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
