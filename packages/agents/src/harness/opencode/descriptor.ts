import { Harness } from "@usine/core/agent/brain";
import { Option } from "effect";
import { CapabilityProfile, Lacking } from "../capability.ts";
import {
  CredentialWiring,
  HarnessCredential,
  HarnessDescriptor,
  WorkerRequirements,
} from "../harness.ts";
import { apiKeys, HarnessPool } from "../pool.ts";

/** The pinned OpenCode release, which `opencode --version` prints as `opencode v<version>`. */
export const OPENCODE_VERSION = "2.3.2";

/**
 * The variable that names the attempt's OpenCode home, a directory on the worker that holds one
 * data directory per session.
 */
export const OPENCODE_HOME = "USINE_OPENCODE_HOME";

/** The variable with the base URL of the OpenAI Responses API that the session calls. */
export const OPENCODE_BASE_URL = "USINE_OPENCODE_BASE_URL";

const wiring = (tokenVariable: string) =>
  CredentialWiring.make({
    tokenVariable,
    environment: { [OPENCODE_BASE_URL]: "{{baseUrl}}", [OPENCODE_HOME]: "{{home}}" },
    files: {},
  });

export const opencode = HarnessDescriptor.make({
  id: Harness.make("opencode"),
  label: "OpenCode",
  worker: WorkerRequirements.make({
    // The launcher's install script fetches only the binary of the worker's platform.
    install: [{ name: "@opencode/cli", version: OPENCODE_VERSION, optionalDependencies: "omit" }],
    versions: [OPENCODE_VERSION],
    login: { mounted: [], seeded: [] },
    credential: Option.some(
      HarnessCredential.make({
        provider: "openai",
        protocol: "openai-responses",
        gatewayPath: "openai-responses/v1",
        home: Option.some(OPENCODE_HOME),
        gateway: wiring("USINE_GATEWAY_TOKEN"),
        apiKey: wiring("OPENAI_API_KEY"),
        // OpenCode has no sandbox placement, so the Cloudflare image doesn't install it.
        cloudflare: CredentialWiring.make({
          tokenVariable: "OPENAI_API_KEY",
          environment: {},
          files: {},
        }),
        label: "OpenAI",
        hosts: [],
        apiHost: "api.openai.com",
        apiKeyBaseUrl: "https://api.openai.com/v1",
      }),
    ),
  }),
  capabilities: [
    CapabilityProfile.make({
      placements: ["local", "ssh", "container"],
      // A gateway that hasn't reported its credential kind yet holds an API key or a login,
      // which the session's route then names; OpenCode runs only on a key.
      credentials: ["gateway", "gateway-api-key", "api-key"],
      supported: ["resume-session", "steer", "interrupt", "token-usage", "cost-usd", "model-check"],
      lacking: [
        Lacking.make({
          capability: "durable-coordination",
          reason:
            "OpenCode resumes sessions without a durable journal of usine tool intents and results",
        }),
        Lacking.make({
          capability: "usine-tools",
          reason: "The OpenCode adapter serves no usine tools yet",
        }),
        Lacking.make({
          capability: "closed-tools",
          reason:
            "The OpenCode adapter closes OpenCode's own tools only for a session with usine tools, which it doesn't serve yet",
        }),
        Lacking.make({
          capability: "structured-output",
          reason: "OpenCode can't constrain an answer to a JSON Schema",
        }),
        Lacking.make({
          capability: "ephemeral",
          reason: "OpenCode saves every session in its data directory",
        }),
        Lacking.make({
          capability: "plan-windows",
          reason: "OpenCode reports no subscription rate windows for an API key",
        }),
      ],
    }),
  ],
  placementReason:
    "OpenCode runs on a worker behind its bridge, which the sandbox image doesn't install",
  credentialReason:
    "OpenCode uses an OpenAI API key, from the attempt or held by the gateway; it uses no login of its own",
  pools: [HarnessPool.make({ pool: apiKeys, routes: ["gateway-api-key", "api-key"] })],
  prices: Option.none(),
  handoff: null,
});
