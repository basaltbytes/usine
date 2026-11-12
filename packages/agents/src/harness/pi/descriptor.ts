import { Harness } from "@usine/core/agent/brain";
import { Option } from "effect";
import { CapabilityProfile, Lacking } from "../capability.ts";
import { HarnessDescriptor, WorkerRequirements } from "../harness.ts";

export const pi = HarnessDescriptor.make({
  id: Harness.make("pi"),
  label: "Pi",
  worker: WorkerRequirements.make({
    install: [],
    versions: [],
    login: { mounted: [], seeded: [] },
    credential: Option.none(),
  }),
  capabilities: [
    CapabilityProfile.make({
      placements: ["orchestrator"],
      credentials: ["host-login", "gateway", "gateway-subscription", "gateway-api-key"],
      supported: [
        "durable-coordination",
        "resume-session",
        "usine-tools",
        "steer",
        "interrupt",
        "token-usage",
        "cost-usd",
        "model-check",
      ],
      lacking: [
        Lacking.make({
          capability: "closed-tools",
          reason: "The Pi adapter keeps the harness's own tools on in every session",
        }),
        Lacking.make({
          capability: "structured-output",
          reason: "The Pi adapter returns text, not a schema-checked value",
        }),
        Lacking.make({
          capability: "ephemeral",
          reason: "The Pi adapter saves every conversation",
        }),
        Lacking.make({
          capability: "plan-windows",
          reason: "Pi does not report subscription rate windows",
        }),
      ],
    }),
    CapabilityProfile.make({
      placements: ["local"],
      credentials: ["host-login"],
      supported: [
        "resume-session",
        "usine-tools",
        "steer",
        "interrupt",
        "token-usage",
        "cost-usd",
        "model-check",
      ],
      lacking: [
        Lacking.make({
          capability: "closed-tools",
          reason: "The Pi adapter keeps the harness's own tools on in every session",
        }),
        Lacking.make({
          capability: "structured-output",
          reason: "The Pi adapter returns text, not a schema-checked value",
        }),
        Lacking.make({
          capability: "ephemeral",
          reason: "The Pi adapter saves every conversation",
        }),
        Lacking.make({
          capability: "durable-coordination",
          reason:
            "Pi children persist conversations without a durable journal of usine tool intents and results",
        }),
        Lacking.make({
          capability: "plan-windows",
          reason: "Pi does not report subscription rate windows",
        }),
      ],
    }),
  ],
  placementReason: "Pi runs its tools in the orchestrator process and supports only local children",
  credentialReason:
    "Pi uses local host credentials for children and host or gateway credentials on the orchestrator",
  prices: Option.none(),
  handoff: null,
});
