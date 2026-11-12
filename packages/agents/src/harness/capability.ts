import { type Brand, Schema } from "effect";

export const Capability = Schema.Literals([
  "durable-coordination",
  "resume-session",
  "steer",
  "interrupt",
  "usine-tools",
  "closed-tools",
  "structured-output",
  "ephemeral",
  "token-usage",
  "cost-usd",
  "plan-windows",
  "model-check",
]);
export type Capability = typeof Capability.Type;

export const Placement = Schema.Literals(["orchestrator", "local", "ssh", "container", "sandbox"]);
export type Placement = typeof Placement.Type;

/** Gateway means the credential kind has not been reported yet. */
export const CredentialRoute = Schema.Literals([
  "host-login",
  "gateway",
  "gateway-subscription",
  "gateway-api-key",
  "api-key",
]);
export type CredentialRoute = typeof CredentialRoute.Type;

const Requirement = Schema.Union([
  Capability,
  Placement,
  Schema.Literals(["credential-route", "registered-harness"]),
]);

export class Lacking extends Schema.Class<Lacking, Brand.Brand<"@usine/agents/harness/Lacking">>(
  "@usine/agents/Lacking",
)({ capability: Requirement, reason: Schema.NonEmptyString }) {}

/** Capabilities of a harness on a set of credential routes and placements. */
export class CapabilityProfile extends Schema.Class<
  CapabilityProfile,
  Brand.Brand<"@usine/agents/harness/CapabilityProfile">
>("@usine/agents/CapabilityProfile")(
  Schema.Struct({
    placements: Schema.NonEmptyArray(Placement),
    credentials: Schema.NonEmptyArray(CredentialRoute),
    supported: Schema.Array(Capability).check(Schema.isUnique()),
    lacking: Schema.Array(Lacking).check(
      Schema.makeFilter(
        (gaps) =>
          new Set(gaps.map(({ capability }) => capability)).size === gaps.length &&
          gaps.every(({ capability }) => Capability.literals.some((value) => value === capability)),
        { message: "Expected distinct capability absence reasons" },
      ),
    ),
  }).check(
    Schema.makeFilter(
      ({ supported, lacking }) =>
        Capability.literals.every(
          (capability) =>
            supported.includes(capability) !== lacking.some((gap) => gap.capability === capability),
        ) || "Every capability must be supported or have a reason for its absence",
    ),
  ),
) {}
