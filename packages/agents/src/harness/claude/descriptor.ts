import { Harness } from "@usine/core/agent/brain";
import { Option } from "effect";
import {
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
        label: "Anthropic",
        hosts: ["api.anthropic.com", "platform.claude.com"],
        apiHost: "api.anthropic.com",
      }),
    ),
  }),
  prices: Option.none(),
  handoff: ResumeCommand.make({ command: "claude --resume", homeVariable: null, gateway: true }),
});
