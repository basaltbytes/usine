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

export const OPENCODE_VERSION = "2.2.5";

const wiring = (tokenVariable: string, environment: Readonly<Record<string, string>>) =>
  CredentialWiring.make({
    tokenVariable,
    environment: {
      ...environment,
      OPENCODE_CONFIG_CONTENT: `{"providers":{"openai":{"package":"@opencode/ai/providers/openai","settings":{"baseURL":"{{baseUrl}}","apiKey":"{env:${tokenVariable}}","transport":"http","encoding":"none"},"body":{"store":false,"instructions":""}}}}`,
    },
    files: {},
  });

export const opencode = HarnessDescriptor.make({
  id: Harness.make("opencode"),
  label: "OpenCode",
  worker: WorkerRequirements.make({
    install: [{ name: "@opencode/cli", version: OPENCODE_VERSION }],
    versions: [`opencode v${OPENCODE_VERSION}`],
    login: { mounted: [".local/share/opencode"], seeded: [".config/opencode"] },
    credential: Option.some(
      HarnessCredential.make({
        provider: "openai",
        protocol: "openai-responses",
        gatewayPath: "openai-responses/v1",
        home: Option.some("XDG_DATA_HOME"),
        gateway: wiring("USINE_GATEWAY_TOKEN", { XDG_DATA_HOME: "{{home}}" }),
        apiKey: wiring("OPENAI_API_KEY", { XDG_DATA_HOME: "{{home}}" }),
        cloudflare: wiring("OPENAI_API_KEY", {}),
        label: "OpenAI",
        hosts: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
        apiHost: "api.openai.com",
        apiKeyBaseUrl: "https://api.openai.com/v1",
      }),
    ),
  }),
  capabilities: [
    CapabilityProfile.make({
      placements: ["orchestrator", "local", "ssh", "container"],
      credentials: ["host-login", "gateway", "gateway-subscription", "gateway-api-key", "api-key"],
      supported: ["resume-session", "steer", "interrupt", "token-usage", "cost-usd", "model-check"],
      lacking: [
        Lacking.make({
          capability: "durable-coordination",
          reason:
            "OpenCode resumes sessions without a durable journal of usine tool intents and results",
        }),
        Lacking.make({
          capability: "usine-tools",
          reason: "The adapter does not expose usine tools",
        }),
        Lacking.make({
          capability: "plan-windows",
          reason: "OpenCode does not report subscription rate windows",
        }),
      ],
    }),
  ],
  placementReason:
    "OpenCode requires a local process or an SSH host with TCP forwarding; sandbox shells do not forward ports",
  credentialReason: "OpenCode requires a configured provider or a host login",
  prices: Option.none(),
  handoff: ResumeCommand.make({
    command: "opencode --session",
    homeVariable: "XDG_DATA_HOME",
    gateway: false,
  }),
});
