import { Harness } from "@usine/core/agent/brain";
import { openai, opencodeGo } from "@usine/core/agent/provider";
import { Option } from "effect";
import { CapabilityProfile, Lacking } from "../capability.ts";
import {
  CredentialWiring,
  HarnessCredential,
  HarnessDescriptor,
  SlotVariable,
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

/** The variable with the base URL of the OpenAI Responses API that the attempt's API key calls. */
export const OPENCODE_BASE_URL = "USINE_OPENCODE_BASE_URL";

/** The variable with the base URL of the gateway's OpenAI slot. */
export const OPENCODE_OPENAI_BASE_URL = "USINE_OPENCODE_OPENAI_BASE_URL";

/** The variable with the base URL of the gateway's OpenCode Go slot. */
export const OPENCODE_GO_BASE_URL = "USINE_OPENCODE_GO_BASE_URL";

export const opencode = HarnessDescriptor.make({
  id: Harness.make("opencode"),
  label: "OpenCode",
  worker: WorkerRequirements.make({
    // The launcher's install script fetches only the binary of the worker's platform.
    install: [{ name: "@opencode/cli", version: OPENCODE_VERSION, method: "launcher" }],
    versions: [OPENCODE_VERSION],
    login: { mounted: [], seeded: [] },
    credential: Option.some(
      HarnessCredential.make({
        slotPath: "/v1",
        home: Option.some(OPENCODE_HOME),
        // A gateway route sets the URL of each slot that the gateway holds, in `slots`, and the
        // API-key route sets `OPENCODE_BASE_URL`, so the environment tells the two apart.
        gateway: CredentialWiring.make({
          tokenVariable: "USINE_GATEWAY_TOKEN",
          environment: { [OPENCODE_HOME]: "{{home}}" },
          files: {},
        }),
        apiKey: CredentialWiring.make({
          tokenVariable: "OPENAI_API_KEY",
          environment: { [OPENCODE_BASE_URL]: "{{baseUrl}}", [OPENCODE_HOME]: "{{home}}" },
          files: {},
        }),
        slots: {
          [openai.id]: SlotVariable.make({ variable: OPENCODE_OPENAI_BASE_URL, path: "/v1" }),
          // OpenCode appends each protocol's path to the plan's one base URL.
          [opencodeGo.id]: SlotVariable.make({ variable: OPENCODE_GO_BASE_URL, path: "" }),
        },
        // OpenCode has no sandbox placement, so the Cloudflare image doesn't install it.
        cloudflare: CredentialWiring.make({
          tokenVariable: "OPENAI_API_KEY",
          environment: {},
          files: {},
        }),
        hosts: [],
      }),
    ),
  }),
  // A bare model ID is OpenAI's; `opencode-go/<model>` selects the plan.
  providers: [openai, opencodeGo],
  modelNotation: "provider/model",
  // The plan's protocols have different upstreams, so an attempt API key reaches OpenAI only.
  gatewayOnly: [opencodeGo.id],
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
          reason: "The OpenCode adapter serves no usine tools",
        }),
        Lacking.make({
          capability: "closed-tools",
          reason:
            "The OpenCode adapter serves no usine tools, which a role without OpenCode's own tools needs",
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
    "OpenCode uses an OpenAI API key, from the attempt or held by the gateway, or an OpenCode Go key held by the gateway; it uses no login of its own",
  pools: [HarnessPool.make({ pool: apiKeys, routes: ["gateway-api-key", "api-key"] })],
  // OpenCode reports each step's cost from its own catalog, so usine keeps no price table.
  prices: Option.none(),
  handoff: null,
});
