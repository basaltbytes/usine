import { AgentName } from "@usine/core/agent";
import type { BrainSpec } from "@usine/core/agent/brain";
import { RoleName } from "@usine/core/agent/session";
import { Option } from "effect";
import { admitBrain, AdmissionContext } from "../admission.ts";
import type { CredentialRoute } from "../capability.ts";
import type { HarnessCatalog } from "../harness.ts";
import { RoleCredentials, RolePlacements, RoleSpec } from "../role.ts";

/**
 * The supervisor: observes and operates the factory for a member, through the operator tools that
 * the member's token allows. It runs on the orchestrator with the gateway credential that the
 * instance already has, keeps its conversation between turns, and lists no harness tools.
 */
export const supervisor = RoleSpec.make({
  name: RoleName.make("supervisor"),
  placement: RolePlacements.make({
    placements: ["orchestrator"],
    reason: "The supervisor runs on the orchestrator host",
  }),
  credential: Option.some(
    RoleCredentials.make({
      credentials: ["gateway", "gateway-subscription", "gateway-api-key"],
      reason: "The supervisor uses the gateway credential that the instance already has",
    }),
  ),
  nativeTools: false,
  hostTools: true,
  persistence: "saved",
  interventions: true,
  output: "text",
});

/**
 * The agent name that supervisor sessions carry. The role runs the instance's `supervisor` brain,
 * not an agent definition.
 */
export const supervisorAgent = AgentName.make("supervisor");

/**
 * Checks that `brain` can run as the supervisor on `credential` at the orchestrator, without IO.
 * Every turn after the first reopens the saved session, so admission also requires
 * `resume-session`.
 */
export const admitSupervisor = (
  catalog: HarnessCatalog,
  brain: BrainSpec,
  credential: CredentialRoute,
) =>
  admitBrain(
    catalog,
    supervisor,
    brain,
    AdmissionContext.make({ placement: "orchestrator", credential }),
    { reopens: true },
  );
