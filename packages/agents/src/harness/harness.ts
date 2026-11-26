import { Harness } from "@usine/core/agent/brain";
import type { PoolDescriptor } from "@usine/core/agent/pool";
import { type GatewaySlot, ModelProvider, ModelProviderCatalog } from "@usine/core/agent/provider";
import { type TokenBreakdown, UsdAmount } from "@usine/core/agent/session";
import { Array as Arr, type Brand, Effect, Equal, Option, Record, Schema } from "effect";
import { CapabilityProfile } from "./capability.ts";
import { HarnessPool } from "./pool.ts";

/** The terminal command for a saved harness session. */
export class ResumeCommand extends Schema.Class<
  ResumeCommand,
  Brand.Brand<"@usine/agents/harness/ResumeCommand">
>("@usine/agents/ResumeCommand")({
  command: Schema.NonEmptyString,
  homeVariable: Schema.NullOr(Schema.NonEmptyString),
  /** Whether the command is usable for a session authenticated by the gateway. */
  gateway: Schema.Boolean,
}) {}

const presentationFields = {
  id: Harness,
  label: Schema.NonEmptyString,
  handoff: Schema.NullOr(ResumeCommand),
};

/** The harness metadata served to operator clients. */
export class HarnessPresentation extends Schema.Class<
  HarnessPresentation,
  Brand.Brand<"@usine/agents/harness/HarnessPresentation">
>("@usine/agents/HarnessPresentation")({
  ...presentationFields,
  /**
   * Why the harness keeps all its own tools when a role limits them, so that only the role's
   * sandbox limits what they reach; null when the harness lists the tools that a role keeps.
   */
  ownTools: Schema.NullOr(Schema.NonEmptyString),
}) {}

/** A secret-free environment and config-file recipe. Values can contain {{baseUrl}} and {{home}}. */
export class CredentialWiring extends Schema.Class<
  CredentialWiring,
  Brand.Brand<"@usine/agents/harness/CredentialWiring">
>("@usine/agents/CredentialWiring")({
  tokenVariable: Schema.NonEmptyString,
  environment: Schema.Record(Schema.String, Schema.String),
  files: Schema.Record(Schema.String, Schema.String),
}) {
  get requiresHome(): boolean {
    return (
      Object.keys(this.files).length > 0 ||
      Object.values(this.environment).some((value) => value.includes("{{home}}"))
    );
  }

  render(baseUrl: string, home: string) {
    const expand = (value: string) =>
      value.replaceAll("{{baseUrl}}", baseUrl).replaceAll("{{home}}", home);
    return {
      tokenVariable: this.tokenVariable,
      environment: Object.fromEntries(
        Object.entries(this.environment).map(([key, value]) => [key, expand(value)]),
      ),
      files: Object.entries(this.files).map(
        ([path, contents]) => [`${home}/${path}`, expand(contents)] as const,
      ),
    };
  }
}

/**
 * How a harness on a worker reaches its providers: through a gateway slot, with an API key, or
 * with a Cloudflare Worker's key, and the hosts of its own login.
 */
export class HarnessCredential extends Schema.Class<
  HarnessCredential,
  Brand.Brand<"@usine/agents/harness/HarnessCredential">
>("@usine/agents/HarnessCredential")(
  Schema.Struct({
    /** The base URL's path under the provider's slot or upstream, such as `/v1`, or empty. */
    slotPath: Schema.String.check(
      Schema.isPattern(/^(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/u, {
        message: "Expected an empty path or one such as /v1",
      }),
    ),
    /** None when credential wiring needs no attempt home. */
    home: Schema.Option(Schema.NonEmptyString),
    gateway: CredentialWiring,
    apiKey: CredentialWiring,
    cloudflare: CredentialWiring,
    /** The hosts of the harness's own login, which it reaches through the gateway's forward proxy. */
    hosts: Schema.Array(Schema.NonEmptyString),
  }).check(
    Schema.makeFilter(
      ({ home, gateway, apiKey, cloudflare }) =>
        ((Option.isSome(home) || (!gateway.requiresHome && !apiKey.requiresHome)) &&
          !cloudflare.requiresHome) ||
        "Credential wiring requires an attempt home; Cloudflare wiring supports environment variables only",
    ),
  ),
) {
  /** Returns the base URL that the API-key wiring gets for `provider`: its first upstream and `slotPath`. */
  apiKeyBaseUrl(provider: ModelProvider): string {
    return `${provider.protocols[0].upstream}${this.slotPath}`;
  }
}

/** Worker installation and login requirements, without secret values. */
export class WorkerRequirements extends Schema.Class<
  WorkerRequirements,
  Brand.Brand<"@usine/agents/harness/WorkerRequirements">
>("@usine/agents/WorkerRequirements")({
  install: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      version: Schema.NonEmptyString,
      /**
       * `global` installs the package with `npm install -g`. `launcher` installs it without its
       * optional dependencies into a prefix of its own and links its commands onto `PATH`, so
       * that its install script fetches only the binary of the worker's platform: npm installs
       * every optional dependency of a global package.
       */
      method: Schema.Literals(["global", "launcher"]).pipe(
        Schema.withConstructorDefault(Effect.succeed("global" as const)),
        Schema.withDecodingDefaultKey(Effect.succeed("global" as const)),
      ),
    }),
  ),
  /** Accepted CLI versions; an empty list accepts any installed version. */
  versions: Schema.Array(Schema.NonEmptyString),
  login: Schema.Struct({
    /** Host configuration variables owned by this harness. */
    environment: Schema.Array(Schema.NonEmptyString).pipe(
      Schema.withConstructorDefault(Effect.succeed([])),
      Schema.withDecodingDefaultKey(Effect.succeed([])),
    ),
    /** Paths under the worker home mounted read-write for token refresh. */
    mounted: Schema.Array(Schema.NonEmptyString),
    /** Paths under the worker home copied when the container starts. */
    seeded: Schema.Array(Schema.NonEmptyString),
  }),
  /** Session directory under the container home, persisted separately from login files. */
  sessionDirectory: Schema.Option(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
    Schema.withDecodingDefaultKey(Effect.succeedNone),
  ),
  credential: Schema.Option(HarnessCredential),
}) {
  get hasAttemptHome(): boolean {
    return (
      Option.isSome(this.sessionDirectory) ||
      Option.exists(this.credential, ({ home }) => Option.isSome(home))
    );
  }
}

/** US dollars per million tokens. Cache writes use the input rate when no rate is supplied. */
const TokenRates = Schema.Struct({
  input: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cachedInput: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheWrite: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  output: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** The credential kind that determines each gateway credential route. */
const GATEWAY_ROUTES = {
  "gateway-api-key": "api-key",
  "gateway-subscription": "subscription",
} as const;

/**
 * Platform-free harness data shared by configuration, workers, and operator reads. A pool's
 * gateway credential route needs a provider of the harness that accepts that kind of credential.
 */
export class HarnessDescriptor extends Schema.Class<
  HarnessDescriptor,
  Brand.Brand<"@usine/agents/harness/HarnessDescriptor">
>("@usine/agents/HarnessDescriptor")(
  Schema.Struct({
    ...presentationFields,
    worker: WorkerRequirements,
    /** The model providers whose gateway slots the harness can use, in the order it prefers them. */
    providers: Schema.Array(ModelProvider),
    capabilities: Schema.NonEmptyArray(CapabilityProfile).check(
      Schema.makeFilter(
        (profiles) => {
          const routes = profiles.flatMap(({ placements, credentials }) =>
            placements.flatMap((placement) =>
              credentials.map((credential) => `${placement}:${credential}`),
            ),
          );
          return new Set(routes).size === routes.length;
        },
        { message: "Expected one capability profile per placement and credential route" },
      ),
    ),
    placementReason: Schema.NonEmptyString,
    credentialReason: Schema.NonEmptyString,
    /** The billing pools of the harness's sessions; a credential route determines at most one. */
    pools: Schema.NonEmptyArray(HarnessPool).check(
      Schema.makeFilter(
        (pools) => {
          const ids = pools.map(({ pool }) => pool.id);
          const routes = pools.flatMap(({ routes }) => routes);
          return new Set(ids).size === ids.length && new Set(routes).size === routes.length;
        },
        { message: "Expected distinct pools, each credential route in at most one" },
      ),
    ),
    /** None when the harness supplies its own prices. */
    prices: Schema.Option(Schema.Record(Schema.String, TokenRates)),
  }).check(
    Schema.makeFilter(
      ({ worker, providers }) =>
        Option.isNone(worker.credential) ||
        providers.length > 0 ||
        "A harness with credential wiring uses at least one provider",
    ),
    Schema.makeFilter(
      ({ providers }) =>
        new Set(providers.map(({ id }) => id)).size === providers.length ||
        "A harness lists each provider once",
    ),
    Schema.makeFilter(({ pools, providers }) => {
      const missing = pools
        .flatMap(({ routes }) => routes)
        .flatMap((route) =>
          route === "gateway-api-key" || route === "gateway-subscription" ? [route] : [],
        )
        .find((route) => !providers.some((provider) => provider.accepts(GATEWAY_ROUTES[route])));
      return (
        missing === undefined ||
        `The pool route ${missing} needs a provider that accepts a ${GATEWAY_ROUTES[missing]} credential`
      );
    }),
  ),
) {
  /** Why the harness can't turn its own tools off, or `None` when it lists the tools a role keeps. */
  get ownToolsKept(): Option.Option<string> {
    return Option.fromNullishOr(
      this.capabilities
        .flatMap(({ lacking }) => lacking)
        .find(({ capability }) => capability === "closed-tools")?.reason,
    );
  }

  /** Returns a price from the bundled table, or None for a model without rates. */
  price(model: string, tokens: TokenBreakdown): Option.Option<UsdAmount> {
    return Option.flatMap(this.prices, (prices) =>
      Option.map(Record.get(prices, model), (rates) =>
        UsdAmount.make(
          (tokens.input * rates.input +
            tokens.cachedInput * rates.cachedInput +
            tokens.cacheWrite * (rates.cacheWrite ?? rates.input) +
            tokens.output * rates.output) /
            1_000_000,
        ),
      ),
    );
  }
}

const declaredPools = (descriptors: ReadonlyArray<HarnessDescriptor>) =>
  descriptors.flatMap(({ pools }) => pools.map(({ pool }) => pool));

const declaredProviders = (descriptors: ReadonlyArray<HarnessDescriptor>) =>
  descriptors.flatMap(({ providers }) => providers);

/** Returns `declared` once each, in declaration order, if two that share an ID are the same. */
const distinct = <A extends { readonly id: string }>(declared: ReadonlyArray<A>) =>
  declared.every((value) =>
    declared.every((other) => other.id !== value.id || Equal.equals(other, value)),
  )
    ? Option.some(Arr.dedupeWith(declared, (left, right) => left.id === right.id))
    : Option.none();

/**
 * A catalog rejects duplicate harness IDs, and a pool ID or a provider ID that two harnesses define
 * differently, and validates registered harnesses at configuration boundaries.
 */
export class HarnessCatalog extends Schema.Class<
  HarnessCatalog,
  Brand.Brand<"@usine/agents/harness/HarnessCatalog">
>("@usine/agents/HarnessCatalog")(
  Schema.Struct({ descriptors: Schema.Array(HarnessDescriptor) }).check(
    Schema.makeFilter(
      ({ descriptors }) =>
        new Set(descriptors.map(({ id }) => id)).size === descriptors.length ||
        "Duplicate harness ID",
    ),
    Schema.makeFilter(
      ({ descriptors }) =>
        Option.isSome(distinct(declaredPools(descriptors))) ||
        "A pool ID that two harnesses declare has one definition",
    ),
    Schema.makeFilter(
      ({ descriptors }) =>
        Option.isSome(
          Option.flatMap(distinct(declaredProviders(descriptors)), (providers) =>
            ModelProviderCatalog.makeOption({ providers }),
          ),
        ) || "A provider ID that two harnesses declare has one definition, and names one slot",
    ),
  ),
) {
  get ids(): ReadonlyArray<Harness> {
    return this.descriptors.map(({ id }) => id);
  }

  /** Every pool that a harness declares, once, in catalog order. */
  get pools(): ReadonlyArray<PoolDescriptor> {
    return Arr.dedupeWith(declaredPools(this.descriptors), (left, right) => left.id === right.id);
  }

  /** Every provider that a harness declares, once, in catalog order. */
  get providers(): ModelProviderCatalog {
    return ModelProviderCatalog.make({
      providers: Arr.dedupeWith(
        declaredProviders(this.descriptors),
        (left, right) => left.id === right.id,
      ),
    });
  }

  get harness() {
    return Harness.check(
      Schema.makeFilter(
        (id) => this.ids.includes(id) || `Unknown harness "${id}". Choose ${this.ids.join(", ")}.`,
      ),
    );
  }

  /** Selects the launched harness's variables from an allowlisted host environment. */
  environmentFor(
    id: Harness,
    environment: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> {
    const variables = (descriptor: HarnessDescriptor) => [
      ...descriptor.worker.login.environment,
      ...Option.toArray(descriptor.worker.credential).flatMap(
        ({ home, gateway, apiKey, cloudflare }) => [
          ...Option.toArray(home),
          ...[gateway, apiKey, cloudflare].flatMap((wiring) => [
            wiring.tokenVariable,
            ...Object.keys(wiring.environment),
          ]),
        ],
      ),
    ];
    const owned = new Set(this.descriptors.flatMap(variables));
    const selected = new Set(Option.toArray(this.get(id)).flatMap(variables));
    return Object.fromEntries(
      Object.entries(environment).filter(([key]) => !owned.has(key) || selected.has(key)),
    );
  }

  get(id: Harness): Option.Option<HarnessDescriptor> {
    return Option.fromNullishOr(this.descriptors.find((descriptor) => descriptor.id === id));
  }

  /**
   * Returns the provider whose credential a Gateway that holds the slots `llmProviders` gives
   * harness `id` on the Workers behind it: the first of the harness's providers that it holds. A
   * harness without credential wiring, such as Pi, or an unknown harness, never uses the Gateway's.
   */
  gatewayProvider(
    id: Harness,
    llmProviders: ReadonlyArray<GatewaySlot>,
  ): Option.Option<ModelProvider> {
    return Option.flatMap(
      Option.filter(this.get(id), ({ worker }) => Option.isSome(worker.credential)),
      ({ providers }) => Arr.findFirst(providers, ({ slot }) => llmProviders.includes(slot)),
    );
  }

  /** Returns whether a Gateway that holds the slots `llmProviders` holds the credential that harness `id` uses. */
  gatewayHolds(id: Harness, llmProviders: ReadonlyArray<GatewaySlot>): boolean {
    return Option.isSome(this.gatewayProvider(id, llmProviders));
  }
}
