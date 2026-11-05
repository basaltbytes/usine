import { Harness } from "@usine/core/agent/brain";
import { Option } from "effect";
import {
  HarnessCredential,
  HarnessDescriptor,
  ResumeCommand,
  WorkerRequirements,
} from "../harness.ts";

/** The pinned app-server protocol baseline used by the conformance check. */
export const CODEX_CLI_VERSION = "0.164.0";

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

export const codex = HarnessDescriptor.make({
  id: Harness.make("codex"),
  capabilities: ["resume-session"],
  label: "Codex",
  worker: WorkerRequirements.make({
    install: [{ name: "@openai/codex", version: CODEX_CLI_VERSION }],
    versions: [CODEX_CLI_VERSION, "0.159.0", "0.159.1", "0.159.2", "0.159.3"],
    login: { mounted: [".codex/auth.json"], seeded: [".codex/config.toml"] },
    credential: Option.some(
      HarnessCredential.make({
        provider: "openai",
        label: "OpenAI",
        hosts: ["chatgpt.com", "auth.openai.com"],
        apiHost: "api.openai.com",
      }),
    ),
  }),
  prices: Option.some(prices),
  handoff: ResumeCommand.make({
    command: "codex resume --",
    homeVariable: "CODEX_HOME",
    gateway: false,
  }),
});
