import { Harness } from "@usine/core/agent/brain";
import { type TokenBreakdown, UsdAmount } from "@usine/core/agent/session";
import { GatewayLlmProvider } from "@usine/core/worker";
import { type Brand, Option, Record, Schema } from "effect";

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

/** The harness metadata served to operator clients. */
export class HarnessPresentation extends Schema.Class<
  HarnessPresentation,
  Brand.Brand<"@usine/agents/harness/HarnessPresentation">
>("@usine/agents/HarnessPresentation")({
  id: Harness,
  label: Schema.NonEmptyString,
  handoff: Schema.NullOr(ResumeCommand),
}) {}

/** A provider credential and the hosts used without a gateway credential. */
export class HarnessCredential extends Schema.Class<
  HarnessCredential,
  Brand.Brand<"@usine/agents/harness/HarnessCredential">
>("@usine/agents/HarnessCredential")({
  provider: GatewayLlmProvider,
  label: Schema.NonEmptyString,
  hosts: Schema.Array(Schema.NonEmptyString),
  apiHost: Schema.NonEmptyString,
}) {}

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
    /** Paths under the worker home mounted read-write for token refresh. */
    mounted: Schema.Array(Schema.NonEmptyString),
    /** Paths under the worker home copied when the container starts. */
    seeded: Schema.Array(Schema.NonEmptyString),
  }),
  credential: Schema.Option(HarnessCredential),
}) {}

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
  ...HarnessPresentation.fields,
  worker: WorkerRequirements,
  /** None when the harness supplies its own prices. */
  prices: Schema.Option(Schema.Record(Schema.String, TokenRates)),
}) {
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

  get(id: Harness): Option.Option<HarnessDescriptor> {
    return Option.fromNullishOr(this.descriptors.find((descriptor) => descriptor.id === id));
  }
}
