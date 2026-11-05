import { Harness } from "@usine/core/agent/brain";
import { Option } from "effect";
import {
  CredentialWiring,
  HarnessCredential,
  HarnessDescriptor,
  ResumeCommand,
  WorkerRequirements,
} from "../harness.ts";

export const claude = HarnessDescriptor.make({
  id: Harness.make("claude"),
  capabilities: ["resume-session"],
  label: "Claude Code",
  worker: WorkerRequirements.make({
    install: [{ name: "@anthropic-ai/claude-code", version: "2.1.311" }],
    versions: [],
    login: { mounted: [".claude/.credentials.json"], seeded: [".claude.json"] },
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
  prices: Option.none(),
  handoff: ResumeCommand.make({ command: "claude --resume", homeVariable: null, gateway: true }),
});
