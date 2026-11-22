import { Harness } from "@usine/core/agent/brain";
import { anthropic, openai } from "@usine/core/agent/provider";
import { Option } from "effect";
import { CapabilityProfile, Lacking } from "../capability.ts";
import { HarnessDescriptor, WorkerRequirements } from "../harness.ts";
import { apiKeys, HarnessPool } from "../pool.ts";
import { piLoginPools } from "./authentication.ts";

export const pi = HarnessDescriptor.make({
  id: Harness.make("pi"),
  label: "Pi",
  worker: WorkerRequirements.make({
    install: [],
    versions: [],
    login: { mounted: [], seeded: [] },
    credential: Option.none(),
  }),
  // Pi on the orchestrator reaches these providers' slots through the gateway's model route.
  providers: [anthropic, openai],
  capabilities: [
    CapabilityProfile.make({
      placements: ["orchestrator"],
      credentials: ["host-login", "gateway", "gateway-subscription", "gateway-api-key"],
      supported: [
        "durable-coordination",
        "resume-session",
        "steer",
        "interrupt",
        "token-usage",
        "usine-tools",
        "closed-tools",
        "cost-usd",
        "model-check",
        "structured-output",
        "ephemeral",
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
      supported: [
        "resume-session",
        "steer",
        "interrupt",
        "token-usage",
        "usine-tools",
        "closed-tools",
        "cost-usd",
        "model-check",
        "structured-output",
        "ephemeral",
      ],
      lacking: [
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
  pools: [
    HarnessPool.make({ pool: apiKeys, routes: ["gateway-api-key"] }),
    ...Array.from(piLoginPools.values(), (pool) => HarnessPool.make({ pool, routes: [] })),
  ],
  prices: Option.none(),
  handoff: null,
});
