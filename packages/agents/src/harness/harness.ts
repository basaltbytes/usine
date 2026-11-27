import { type BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import type { PoolDescriptor } from "@usine/core/agent/pool";
import {
  type GatewaySlot,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderId,
} from "@usine/core/agent/provider";
import { type TokenBreakdown, UsdAmount } from "@usine/core/agent/session";
import { Array as Arr, type Brand, Effect, Equal, Option, Record, Result, Schema } from "effect";
import { UnknownModelError } from "../runtime.ts";
import {
  CapabilityProfile,
  type CredentialRoute,
  isGatewayRoute,
  type Placement,
} from "./capability.ts";
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

/** A base URL's path under a provider's slot or upstream, such as `/v1`, or empty. */
const SlotPath = Schema.String.check(
  Schema.isPattern(/^(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/u, {
    message: "Expected an empty path or one such as /v1",
  }),
);

/** The variable that holds the URL of a provider's gateway slot, and the URL's path under the slot. */
export class SlotVariable extends Schema.Class<
  SlotVariable,
  Brand.Brand<"@usine/agents/harness/SlotVariable">
>("@usine/agents/SlotVariable")({
  variable: Schema.NonEmptyString,
  path: SlotPath,
}) {}

/**
 * How a harness on a worker reaches its providers: through a gateway slot, with an API key, or
 * with a Cloudflare Worker's key, and the hosts of its own login.
 */
export class HarnessCredential extends Schema.Class<
  HarnessCredential,
  Brand.Brand<"@usine/agents/harness/HarnessCredential">
>("@usine/agents/HarnessCredential")(
  Schema.Struct({
    /** The path of `{{baseUrl}}` under the provider's slot or upstream, such as `/v1`, or empty. */
    slotPath: SlotPath,
    /**
     * The variables that a gateway route sets to the URL of each provider's slot, by provider ID,
     * for each provider that the gateway holds. A harness that runs models of several providers
     * reads the variable of the model's provider, where `{{baseUrl}}` has only the first one.
     */
    slots: Schema.Record(ModelProviderId, SlotVariable).pipe(
      Schema.withConstructorDefault(Effect.succeed({})),
      Schema.withDecodingDefaultKey(Effect.succeed({})),
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
  /**
   * Returns the base URL that the API-key wiring gets for `provider`: the upstream that its
   * protocols share, and `slotPath`. A descriptor that offers the `api-key` route outside a sandbox
   * reaches only providers whose protocols share an upstream with it.
   */
  apiKeyBaseUrl(provider: ModelProvider): string {
    return `${provider.protocols[0].upstream}${this.slotPath}`;
  }

  /**
   * Returns the slot variables of `held`, the providers whose credential the gateway holds: each
   * variable that `slots` names for one of them, set to `slotUrl` of the provider and the path.
   */
  slotEnvironment(
    held: ReadonlyArray<ModelProvider>,
    slotUrl: (provider: ModelProvider, path: string) => string,
  ): Readonly<Record<string, string>> {
    return Object.fromEntries(
      held.flatMap((provider) =>
        Option.toArray(Record.get(this.slots, provider.id)).map(
          ({ variable, path }) => [variable, slotUrl(provider, path)] as const,
        ),
      ),
    );
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

/**
 * The provider of a session's model, and the model's ID in that provider's list. Construct it with
 * `HarnessDescriptor.providerOf`.
 */
export class ModelChoice extends Schema.Class<
  ModelChoice,
  Brand.Brand<"@usine/agents/harness/ModelChoice">
>("@usine/agents/ModelChoice")({
  provider: ModelProvider,
  /** The model ID without a provider prefix, such as `gpt-5.4-mini`. */
  model: ModelId,
}) {}

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
    /**
     * How a model ID names its provider: in `model`, every model is the first provider's; in
     * `provider/model`, an ID such as `opencode-go/glm-5.3` names the provider before its first
     * `/`, and an ID without one is the first provider's.
     */
    modelNotation: Schema.Literals(["model", "provider/model"]).pipe(
      Schema.withConstructorDefault(Effect.succeed("model" as const)),
      Schema.withDecodingDefaultKey(Effect.succeed("model" as const)),
    ),
    /**
     * The IDs of the providers that the harness reaches only through a gateway slot or a sandbox,
     * never with an attempt API key outside a sandbox: a provider whose protocols have different
     * upstreams, which one base URL can't reach.
     */
    gatewayOnly: Schema.Array(ModelProviderId).pipe(
      Schema.withConstructorDefault(Effect.succeed([])),
      Schema.withDecodingDefaultKey(Effect.succeed([])),
    ),
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
    Schema.makeFilter(({ providers, gatewayOnly, worker }) => {
      const listed = [
        ...gatewayOnly,
        ...Option.toArray(worker.credential).flatMap(({ slots }) => Object.keys(slots)),
      ];
      const unknown = listed.find((id) => !providers.some((provider) => provider.id === id));
      return (
        unknown === undefined ||
        `The provider ${unknown} that the descriptor names isn't one of the harness's providers`
      );
    }),
    Schema.makeFilter(({ capabilities, providers, gatewayOnly }) => {
      const direct = capabilities.some(
        ({ placements, credentials }) =>
          credentials.includes("api-key") &&
          placements.some((placement) => placement !== "sandbox"),
      );
      const split = providers.find(
        ({ id, sharedUpstream }) => Option.isNone(sharedUpstream) && !gatewayOnly.includes(id),
      );
      return (
        !direct ||
        split === undefined ||
        `The api-key route outside a sandbox can't reach ${split.label}: with an attempt API key, the harness calls one upstream, and ${split.label}'s protocols have different upstreams. List it as gateway-only, reach it through the gateway, or in a sandbox, whose handler sends each path to its protocol's upstream.`
      );
    }),
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

  /** The providers that an attempt API key outside a sandbox reaches, in the order the harness prefers them. */
  get apiKeyProviders(): ReadonlyArray<ModelProvider> {
    return this.providers.filter(({ id }) => !this.gatewayOnly.includes(id));
  }

  /**
   * Returns the provider and model that `model` selects in the descriptor's `modelNotation`. Fails
   * for a prefix that names none of the harness's providers, for an empty model ID after the
   * prefix, and for a harness without providers.
   */
  providerOf(model: ModelId): Result.Result<ModelChoice, UnknownModelError> {
    const separator = this.modelNotation === "provider/model" ? model.indexOf("/") : -1;
    const prefix =
      separator === -1 ? Option.none<string>() : Option.some(model.slice(0, separator));
    const provider = Option.match(prefix, {
      onNone: () => Arr.head(this.providers),
      onSome: (id) => Arr.findFirst(this.providers, (listed) => listed.id === id),
    });
    const refuse = (message: string) =>
      Result.fail(UnknownModelError.make({ harness: this.id, model, message }));
    if (Option.isNone(provider)) {
      const listed = this.providers.map(({ id }) => id);
      return Option.match(prefix, {
        onNone: () => refuse(`${this.label} uses no model provider`),
        onSome: (id) =>
          refuse(
            `${this.label} has no provider "${id}" for the model "${model}". Choose one of ${listed.join(", ")} as <provider>/<model>; a model ID without a provider is ${listed[0] ?? "none"}'s.`,
          ),
      });
    }
    return Option.match(Schema.decodeOption(ModelId)(model.slice(separator + 1)), {
      onNone: () => refuse(`The model "${model}" names no model after its provider`),
      onSome: (id) => Result.succeed(ModelChoice.make({ provider: provider.value, model: id })),
    });
  }

  /**
   * Returns whether a session at `placement` on `route` reaches the models of `provider`: through a
   * gateway slot, in a sandbox, whose handler sends each path to its protocol's upstream, or
   * otherwise for a provider that isn't gateway-only.
   */
  reaches(provider: ModelProvider, placement: Placement, route: CredentialRoute): boolean {
    return (
      isGatewayRoute(route) || placement === "sandbox" || !this.gatewayOnly.includes(provider.id)
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
        ({ home, gateway, apiKey, cloudflare, slots }) => [
          ...Option.toArray(home),
          ...Object.values(slots).map(({ variable }) => variable),
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

  /**
   * Returns whether a Gateway that holds the slots `llmProviders` holds the credential of one of
   * harness `id`'s providers, so that the Workers behind it get the harness's Gateway wiring.
   */
  gatewayHolds(id: Harness, llmProviders: ReadonlyArray<GatewaySlot>): boolean {
    return Option.isSome(this.gatewayProvider(id, llmProviders));
  }

  /**
   * Returns the provider whose slot or API key a session of `brain` uses: the provider that its
   * model names. `None` for a harness without credential wiring, such as Pi, an unknown harness,
   * or a model that names none of the harness's providers, which the harness refuses at launch.
   */
  modelProvider(brain: Pick<BrainSpec, "harness" | "model">): Option.Option<ModelProvider> {
    return Option.flatMap(
      Option.filter(this.get(brain.harness), ({ worker }) => Option.isSome(worker.credential)),
      (descriptor) =>
        Option.map(
          Result.getSuccess(descriptor.providerOf(brain.model)),
          ({ provider }) => provider,
        ),
    );
  }

  /**
   * Returns the provider of `brain`'s model if a Gateway that holds the slots `llmProviders` holds
   * its slot, and so injects the credential that a session of `brain` uses.
   */
  modelGatewayProvider(
    brain: Pick<BrainSpec, "harness" | "model">,
    llmProviders: ReadonlyArray<GatewaySlot>,
  ): Option.Option<ModelProvider> {
    return Option.filter(this.modelProvider(brain), ({ slot }) => llmProviders.includes(slot));
  }
}
