import { Harness } from "@usine/core/agent/brain";
import { Option } from "effect";
import { CapabilityProfile, Lacking } from "../capability.ts";
import {
  CredentialWiring,
  HarnessCredential,
  HarnessDescriptor,
  ResumeCommand,
  WorkerRequirements,
} from "../harness.ts";

export const claude = HarnessDescriptor.make({
  id: Harness.make("claude"),
  label: "Claude Code",
  worker: WorkerRequirements.make({
    sessionDirectory: Option.some(".claude/projects"),
    install: [{ name: "@anthropic-ai/claude-code", version: "2.1.311" }],
    versions: [],
    login: {
      environment: [
        "CLAUDE_CONFIG_DIR",
        "ENABLE_CLAUDEAI_MCP_SERVERS",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      ],
      mounted: [".claude/.credentials.json"],
      seeded: [".claude.json"],
    },
    credential: Option.some(
      HarnessCredential.make({
        provider: "anthropic",
        protocol: "anthropic-messages",
        gatewayPath: "anthropic-messages",
        home: Option.none(),
        gateway: CredentialWiring.make({
          tokenVariable: "ANTHROPIC_AUTH_TOKEN",
          environment: { ANTHROPIC_BASE_URL: "{{baseUrl}}" },
          files: {},
        }),
        apiKey: CredentialWiring.make({
          tokenVariable: "ANTHROPIC_API_KEY",
          environment: {},
          files: {},
        }),
        cloudflare: CredentialWiring.make({
          tokenVariable: "ANTHROPIC_API_KEY",
          environment: {
            ANTHROPIC_BASE_URL: "{{baseUrl}}",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
          files: {},
        }),
        label: "Anthropic",
        hosts: ["api.anthropic.com", "platform.claude.com"],
        apiHost: "api.anthropic.com",
        apiKeyBaseUrl: "https://api.anthropic.com/v1",
      }),
    ),
  }),
  capabilities: [
    CapabilityProfile.make({
      placements: ["orchestrator", "local", "ssh", "container", "sandbox"],
      credentials: ["host-login", "gateway-subscription"],
      supported: [
        "resume-session",
        "steer",
        "interrupt",
        "token-usage",
        "cost-usd",
        "plan-windows",
      ],
      lacking: [
        Lacking.make({
          capability: "usine-tools",
          reason: "The Claude Code adapter passes no usine tool set to a session",
        }),
        Lacking.make({
          capability: "closed-tools",
          reason: "The Claude Code adapter keeps the harness's own tools on in every session",
        }),
        Lacking.make({
          capability: "structured-output",
          reason: "The Claude Code adapter returns text, not a schema-checked value",
        }),
        Lacking.make({
          capability: "ephemeral",
          reason: "The Claude Code adapter saves every conversation",
        }),
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
      supported: ["resume-session", "steer", "interrupt", "token-usage", "cost-usd"],
      lacking: [
        Lacking.make({
          capability: "usine-tools",
          reason: "The Claude Code adapter passes no usine tool set to a session",
        }),
        Lacking.make({
          capability: "closed-tools",
          reason: "The Claude Code adapter keeps the harness's own tools on in every session",
        }),
        Lacking.make({
          capability: "structured-output",
          reason: "The Claude Code adapter returns text, not a schema-checked value",
        }),
        Lacking.make({
          capability: "ephemeral",
          reason: "The Claude Code adapter saves every conversation",
        }),
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
