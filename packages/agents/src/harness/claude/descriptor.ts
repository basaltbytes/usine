import { Harness } from "@usine/core/agent/brain";
import { Option } from "effect";
import { CapabilityProfile, Lacking } from "../capability.ts";
import {
  HarnessCredential,
  HarnessDescriptor,
  ResumeCommand,
  WorkerRequirements,
} from "../harness.ts";

export const claude = HarnessDescriptor.make({
  id: Harness.make("claude"),
  label: "Claude Code",
  worker: WorkerRequirements.make({
    install: [{ name: "@anthropic-ai/claude-code", version: "2.1.311" }],
    versions: [],
    login: { mounted: [".claude/.credentials.json"], seeded: [".claude.json"] },
    credential: Option.some(
      HarnessCredential.make({
        provider: "anthropic",
        label: "Anthropic",
        hosts: ["api.anthropic.com", "platform.claude.com"],
        apiHost: "api.anthropic.com",
      }),
    ),
  }),
  capabilities: [
    CapabilityProfile.make({
      placements: ["orchestrator", "local", "ssh", "container", "sandbox"],
      credentials: ["host-login", "gateway-subscription"],
      supported: [
        "resume-session",
        "usine-tools",
        "steer",
        "interrupt",
        "token-usage",
        "cost-usd",
        "plan-windows",
      ],
      lacking: [
        Lacking.make({
          capability: "durable-coordination",
          reason:
            "Claude Code resumes conversations without a durable journal of usine tool intents and results",
        }),
        Lacking.make({
          capability: "model-check",
          reason: "Claude Code checks the model when the first request starts",
        }),
      ],
    }),
    CapabilityProfile.make({
      placements: ["orchestrator", "local", "ssh", "container", "sandbox"],
      credentials: ["gateway", "gateway-api-key", "api-key"],
      supported: ["resume-session", "usine-tools", "steer", "interrupt", "token-usage", "cost-usd"],
      lacking: [
        Lacking.make({
          capability: "durable-coordination",
          reason:
            "Claude Code resumes conversations without a durable journal of usine tool intents and results",
        }),
        Lacking.make({
          capability: "model-check",
          reason: "Claude Code checks the model when the first request starts",
        }),
        Lacking.make({
          capability: "plan-windows",
          reason:
            "API keys and unreported gateway credentials have no verified subscription rate windows",
        }),
      ],
    }),
  ],
  placementReason: "The harness requires a process host",
  credentialReason:
    "The harness requires its own login or a provider credential on the gateway or attempt",
  prices: Option.none(),
  handoff: ResumeCommand.make({ command: "claude --resume", homeVariable: null, gateway: true }),
});
