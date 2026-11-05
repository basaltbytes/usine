import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { Array as Arr, type Brand, Option, Result, Schema } from "effect";
import { Capability, CredentialRoute, Lacking, Placement } from "./capability.ts";
import type { HarnessCatalog } from "./harness.ts";

export const Role = Schema.Literals(["coordinator", "coding-agent", "supervisor"]);
export type Role = typeof Role.Type;

const interactive: ReadonlyArray<Capability> = ["steer", "interrupt", "token-usage"];
const requirements = {
  coordinator: ["durable-coordination", "usine-tools", ...interactive],
  "coding-agent": interactive,
  supervisor: ["usine-tools", "resume-session", ...interactive],
} satisfies Record<Role, ReadonlyArray<Capability>>;

export class AdmissionContext extends Schema.Class<
  AdmissionContext,
  Brand.Brand<"@usine/agents/harness/AdmissionContext">
>("@usine/agents/AdmissionContext")({ placement: Placement, credential: CredentialRoute }) {}

export class AdmittedBrain extends Schema.Class<
  AdmittedBrain,
  Brand.Brand<"@usine/agents/harness/AdmittedBrain">
>("@usine/agents/AdmittedBrain")({ role: Role, brain: BrainSpec, context: AdmissionContext }) {}

export class BrainRefused extends Schema.TaggedError<
  BrainRefused,
  Brand.Brand<"@usine/agents/harness/BrainRefused">
>("@usine/agents/BrainRefused")("BrainRefused", {
  role: Role,
  harness: Harness,
  model: ModelId,
  missing: Schema.NonEmptyArray(Lacking),
  message: Schema.NonEmptyString,
}) {}

/** Checks role requirements without IO or inspecting secret values. */
export const admitBrain = (
  catalog: HarnessCatalog,
  role: Role,
  brain: BrainSpec,
  context: AdmissionContext,
  capabilities: ReadonlyArray<Capability> = [],
): Result.Result<AdmittedBrain, BrainRefused> => {
  const missing: Array<Lacking> = [];
  const descriptor = catalog.get(brain.harness);
  if (Option.isNone(descriptor)) {
    missing.push(
      Lacking.make({
        capability: "registered-harness",
        reason: `No descriptor is registered for ${brain.harness}`,
      }),
    );
  } else {
    const adapter = descriptor.value;
    const placement = context.placement;
    if (role !== "coding-agent" && placement !== "orchestrator") {
      missing.push(
        Lacking.make({
          capability: "orchestrator",
          reason: `The ${role} role runs on the orchestrator host`,
        }),
      );
    } else if (role === "coding-agent" && placement === "orchestrator") {
      missing.push(
        Lacking.make({ capability: "local", reason: "The coding-agent role runs on a worker" }),
      );
    }
    if (role === "supervisor" && !context.credential.startsWith("gateway")) {
      missing.push(
        Lacking.make({
          capability: "credential-route",
          reason:
            "The supervisor uses a gateway credential so subscription credentials stay on the gateway",
        }),
      );
    }
    const profiles = adapter.capabilities;
    if (!profiles.some((profile) => profile.placements.includes(placement))) {
      missing.push(Lacking.make({ capability: placement, reason: adapter.placementReason }));
    } else {
      const profile = profiles.find(
        (profile) =>
          profile.placements.includes(placement) &&
          profile.credentials.includes(context.credential),
      );
      if (profile === undefined) {
        missing.push(
          Lacking.make({ capability: "credential-route", reason: adapter.credentialReason }),
        );
      } else {
        missing.push(
          ...profile.lacking.filter((gap) =>
            [...requirements[role], ...capabilities].some(
              (required) => required === gap.capability,
            ),
          ),
        );
      }
    }
  }
  if (Arr.isArrayNonEmpty(missing)) {
    return Result.fail(
      BrainRefused.make({
        role,
        harness: brain.harness,
        model: brain.model,
        missing,
        message: `${brain.harness} cannot run as ${role} at ${context.placement}: ${missing.map(({ capability, reason }) => `lacks ${capability} (${reason})`).join("; ")}`,
      }),
    );
  }
  return Result.succeed(AdmittedBrain.make({ role, brain, context }));
};
