import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { BillingPool, RoleName } from "@usine/core/agent/session";
import type { GatewayLlmProvider } from "@usine/core/worker";
import { Array as Arr, type Brand, Option, Result, Schema } from "effect";
import { CredentialRoute, Lacking, Placement } from "./capability.ts";
import type { HarnessCatalog, HarnessDescriptor } from "./harness.ts";
import { requirements, RoleSpec } from "./role.ts";

export class AdmissionContext extends Schema.Class<
  AdmissionContext,
  Brand.Brand<"@usine/agents/harness/AdmissionContext">
>("@usine/agents/AdmissionContext")({ placement: Placement, credential: CredentialRoute }) {}

export class AdmittedBrain extends Schema.Class<
  AdmittedBrain,
  Brand.Brand<"@usine/agents/harness/AdmittedBrain">
>("@usine/agents/AdmittedBrain")({
  role: RoleSpec,
  brain: BrainSpec,
  context: AdmissionContext,
  /**
   * The billing pool that the credential route determines, or `None` when the harness reports the
   * pool at launch, as with its own login.
   */
  pool: Schema.Option(BillingPool),
}) {}

export class BrainRefused extends Schema.TaggedError<
  BrainRefused,
  Brand.Brand<"@usine/agents/harness/BrainRefused">
>("@usine/agents/BrainRefused")("BrainRefused", {
  role: RoleName,
  harness: Harness,
  model: ModelId,
  missing: Schema.NonEmptyArray(Lacking),
  message: Schema.NonEmptyString,
}) {}

const subscriptionPools = {
  anthropic: "claudePlan",
  openai: "chatgptPlan",
} satisfies Record<GatewayLlmProvider, BillingPool>;

/**
 * The billing pool that `credential` determines for `descriptor`. A gateway route that reports
 * its credential kind determines the pool; every other route leaves it to the harness at launch.
 */
export const routePool = (
  descriptor: HarnessDescriptor,
  credential: CredentialRoute,
): Option.Option<BillingPool> => {
  if (credential === "gateway-api-key") return Option.some("apiKeys");
  if (credential !== "gateway-subscription") return Option.none();
  return Option.map(descriptor.worker.credential, ({ provider }) => subscriptionPools[provider]);
};

/**
 * Checks what `role` requires of `brain` at `context`, without IO or inspecting secret values.
 * `reopens` adds what reopening a saved conversation needs. A refusal lists every missing
 * capability, placement, or credential route with the reason that the role or the harness
 * descriptor gives for it.
 */
export const admitBrain = (
  catalog: HarnessCatalog,
  role: RoleSpec,
  brain: BrainSpec,
  context: AdmissionContext,
  options: { readonly reopens: boolean } = { reopens: false },
): Result.Result<AdmittedBrain, BrainRefused> => {
  const missing: Array<Lacking> = [];
  const descriptor = catalog.get(brain.harness);
  const { placement, credential } = context;
  if (Option.isNone(descriptor)) {
    missing.push(
      Lacking.make({
        capability: "registered-harness",
        reason: `No descriptor is registered for ${brain.harness}`,
      }),
    );
  } else {
    const adapter = descriptor.value;
    if (!role.placement.placements.includes(placement)) {
      // The refusal names a placement that the role runs at, which this context lacks.
      missing.push(
        Lacking.make({
          capability: role.placement.placements[0],
          reason: role.placement.reason,
        }),
      );
    }
    if (Option.isSome(role.credential) && !role.credential.value.credentials.includes(credential)) {
      missing.push(
        Lacking.make({ capability: "credential-route", reason: role.credential.value.reason }),
      );
    }
    const profiles = adapter.capabilities;
    if (!profiles.some((profile) => profile.placements.includes(placement))) {
      missing.push(Lacking.make({ capability: placement, reason: adapter.placementReason }));
    } else {
      const profile = profiles.find(
        (profile) =>
          profile.placements.includes(placement) && profile.credentials.includes(credential),
      );
      if (profile === undefined) {
        missing.push(
          Lacking.make({ capability: "credential-route", reason: adapter.credentialReason }),
        );
      } else {
        const required = requirements(role, options);
        missing.push(
          ...profile.lacking.filter((gap) => required.some((need) => need === gap.capability)),
        );
      }
    }
  }
  if (Arr.isArrayNonEmpty(missing)) {
    return Result.fail(
      BrainRefused.make({
        role: role.name,
        harness: brain.harness,
        model: brain.model,
        missing,
        message: `${brain.harness} cannot run as ${role.name} at ${placement}: ${missing.map(({ capability, reason }) => `lacks ${capability} (${reason})`).join("; ")}`,
      }),
    );
  }
  return Result.succeed(
    AdmittedBrain.make({
      role,
      brain,
      context,
      pool: Option.flatMap(descriptor, (adapter) => routePool(adapter, credential)),
    }),
  );
};
