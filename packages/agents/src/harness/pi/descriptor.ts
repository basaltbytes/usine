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
      credentials: ["host-login"],
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
          capability: "plan-windows",
          reason: "Pi does not report subscription rate windows",
        }),
      ],
    }),
    CapabilityProfile.make({
      placements: ["local"],
      credentials: ["host-login"],
      supported: ["usine-tools", "steer", "interrupt", "token-usage", "cost-usd", "model-check"],
      lacking: [
        Lacking.make({
          capability: "durable-coordination",
          reason:
            "Pi children use in-memory sessions; only the orchestrator coordinator uses pi-durable",
        }),
        Lacking.make({
          capability: "resume-session",
          reason: "Pi children use in-memory sessions",
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
    "Pi uses the orchestrator's provider credentials, not gateway or attempt credentials",
  prices: Option.none(),
  handoff: null,
});
