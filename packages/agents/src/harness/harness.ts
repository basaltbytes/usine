import { Harness } from "@usine/core/agent/brain";
import { type TokenBreakdown, UsdAmount } from "@usine/core/agent/session";
import { GatewayLlmProtocol, GatewayLlmProvider } from "@usine/core/worker";
import { type Brand, Effect, Option, Record, Schema } from "effect";
import { CapabilityProfile } from "./capability.ts";

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

/** A provider credential and the hosts used without a gateway credential. */
export class HarnessCredential extends Schema.Class<
  HarnessCredential,
  Brand.Brand<"@usine/agents/harness/HarnessCredential">
>("@usine/agents/HarnessCredential")(
  Schema.Struct({
    provider: GatewayLlmProvider,
    protocol: GatewayLlmProtocol,
    gatewayPath: Schema.NonEmptyString,
    /** None when credential wiring needs no attempt home. */
    home: Schema.Option(Schema.NonEmptyString),
    gateway: CredentialWiring,
    apiKey: CredentialWiring,
    cloudflare: CredentialWiring,
    label: Schema.NonEmptyString,
    hosts: Schema.Array(Schema.NonEmptyString),
    apiHost: Schema.NonEmptyString,
    apiKeyBaseUrl: Schema.NonEmptyString,
  }).check(
    Schema.makeFilter(
      ({ home, gateway, apiKey, cloudflare }) =>
        ((Option.isSome(home) || (!gateway.requiresHome && !apiKey.requiresHome)) &&
          !cloudflare.requiresHome) ||
        "Credential wiring requires an attempt home; Cloudflare wiring supports environment variables only",
    ),
  ),
) {}

/** Worker installation and login requirements, without secret values. */
export class WorkerRequirements extends Schema.Class<
  WorkerRequirements,
  Brand.Brand<"@usine/agents/harness/WorkerRequirements">
>("@usine/agents/WorkerRequirements")({
  install: Schema.Array(
    Schema.Struct({ name: Schema.NonEmptyString, version: Schema.NonEmptyString }),
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

/** Platform-free harness data shared by configuration, workers, and operator reads. */
export class HarnessDescriptor extends Schema.Class<
  HarnessDescriptor,
  Brand.Brand<"@usine/agents/harness/HarnessDescriptor">
>("@usine/agents/HarnessDescriptor")({
  ...presentationFields,
  worker: WorkerRequirements,
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
  /** None when the harness supplies its own prices. */
  prices: Schema.Option(Schema.Record(Schema.String, TokenRates)),
}) {
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

/** A catalog rejects duplicate IDs and validates registered harnesses at configuration boundaries. */
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
  ),
) {
  get ids(): ReadonlyArray<Harness> {
    return this.descriptors.map(({ id }) => id);
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
}
