import { Harness } from "@usine/core/agent/brain";
import { Option } from "effect";
import { CODEX_PROTOCOL } from "../../protocol/codex/version.ts";
import { CapabilityProfile, Lacking } from "../capability.ts";
import {
  CredentialWiring,
  HarnessCredential,
  HarnessDescriptor,
  ResumeCommand,
  WorkerRequirements,
} from "../harness.ts";

/** The pinned app-server protocol baseline used by the conformance check. */
export const CODEX_CLI_VERSION = CODEX_PROTOCOL.version;

// Standard tier, up to 272K input tokens. Read from
// https://developers.openai.com/api/docs/pricing on 2026-10-26.
// Cache writes use the 30-minute rate, as Codex sets no retention.
const prices = {
  "gpt-6-astra": { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  "gpt-6-sol": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
};

const credentialConfig = (id: string, name: string, tokenVariable: string) =>
  [
    `model_provider = "${id}"`,
    "",
    `[model_providers.${id}]`,
    `name = "${name}"`,
    'base_url = "{{baseUrl}}"',
    `env_key = "${tokenVariable}"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");

export const codex = HarnessDescriptor.make({
  id: Harness.make("codex"),
  label: "Codex",
  worker: WorkerRequirements.make({
    install: [{ name: "@openai/codex", version: CODEX_CLI_VERSION }],
    versions: [CODEX_CLI_VERSION, "0.159.0", "0.159.1", "0.159.2", "0.159.3"],
    login: {
      environment: ["CODEX_HOME"],
      mounted: [".codex/auth.json"],
      seeded: [".codex/config.toml"],
    },
    credential: Option.some(
      HarnessCredential.make({
        provider: "openai",
        protocol: "openai-responses",
        gatewayPath: "openai-responses/v1",
        home: Option.some("CODEX_HOME"),
        gateway: CredentialWiring.make({
          tokenVariable: "USINE_GATEWAY_TOKEN",
          environment: { CODEX_HOME: "{{home}}" },
          files: {
            "config.toml": credentialConfig(
              "usine-gateway",
              "usine gateway",
              "USINE_GATEWAY_TOKEN",
            ),
          },
        }),
        apiKey: CredentialWiring.make({
          tokenVariable: "OPENAI_API_KEY",
          environment: { CODEX_HOME: "{{home}}" },
          files: {
            "config.toml": credentialConfig("usine-openai", "OpenAI API key", "OPENAI_API_KEY"),
          },
        }),
        cloudflare: CredentialWiring.make({
          tokenVariable: "OPENAI_API_KEY",
          environment: {},
          files: {},
        }),
        label: "OpenAI",
        hosts: ["chatgpt.com", "auth.openai.com"],
        apiHost: "api.openai.com",
        apiKeyBaseUrl: "https://api.openai.com/v1",
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
        "model-check",
        "plan-windows",
        "structured-output",
        "ephemeral",
      ],
      lacking: [
        Lacking.make({
          capability: "usine-tools",
          reason:
            "The Codex adapter passes no usine tool set to a session until step 19 of the harness adapter plan",
        }),
        Lacking.make({
          capability: "closed-tools",
          reason: "The Codex adapter keeps the harness's own tools on in every session",
        }),
        Lacking.make({
          capability: "durable-coordination",
          reason:
            "Codex resumes conversations without a durable journal of usine tool intents and results",
        }),
        Lacking.make({
          capability: "cost-usd",
          reason: "Codex reports tokens; usine estimates USD from a price table",
        }),
      ],
    }),
    CapabilityProfile.make({
      placements: ["orchestrator", "local", "ssh", "container", "sandbox"],
      credentials: ["gateway", "gateway-api-key", "api-key"],
      supported: [
        "resume-session",
        "steer",
        "interrupt",
        "token-usage",
        "model-check",
        "structured-output",
        "ephemeral",
      ],
      lacking: [
        Lacking.make({
          capability: "usine-tools",
          reason:
            "The Codex adapter passes no usine tool set to a session until step 19 of the harness adapter plan",
        }),
        Lacking.make({
          capability: "closed-tools",
          reason: "The Codex adapter keeps the harness's own tools on in every session",
        }),
        Lacking.make({
          capability: "durable-coordination",
          reason:
            "Codex resumes conversations without a durable journal of usine tool intents and results",
        }),
        Lacking.make({
          capability: "cost-usd",
          reason: "Codex reports tokens; usine estimates USD from a price table",
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
  prices: Option.some(prices),
  handoff: ResumeCommand.make({
    command: "codex resume --",
    homeVariable: "CODEX_HOME",
    gateway: false,
  }),
});
