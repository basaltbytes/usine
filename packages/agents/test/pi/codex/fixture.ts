import { Harness, BrainSpec, Effort, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { AgentName } from "@usine/core/agent";
import { Option, Schema } from "effect";
import { WorkerName } from "@usine/core/worker";
import { type ChildHost, LocalProcess } from "../../../src/child-host/child-host.ts";
import { ChildRequest, WorkingDirectory } from "../../../src/runtime.ts";

export const request = (
  model = "gpt-5.6-terra",
  effort: Effort = "off",
  host: ChildHost = LocalProcess.make(),
) =>
  ChildRequest.make({
    worker: WorkerName.make("worker-1"),
    machine: Option.none(),
    environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
    host,
    session: ChildSession.make({
      id: AgentSessionId.make("codex-child-1"),
      parentId: AgentSessionId.make("parent-1"),
      agent: AgentName.make("developer"),
      brain: BrainSpec.make({
        harness: Harness.make("codex"),
        model: ModelId.make(model),
        effort,
      }),
    }),
    cwd: WorkingDirectory.make("/workspace/repo"),
    prompt: "Implement the focused task.",
    receipts: Option.some([]),
  });

export const successfulResponses = (
  models: ReadonlyArray<{
    readonly id: string;
    readonly model: string;
    readonly supportedReasoningEfforts?: ReadonlyArray<{ readonly reasoningEffort: string }>;
  }>,
) =>
  ({
    initialize: {},
    "account/read": {
      account: { type: "chatgpt", email: "operator@example.com" },
      requiresOpenaiAuth: true,
    },
    "model/list": { data: models },
    "thread/start": {
      modelProvider: "openai",
      thread: { id: "thread-1" },
      model: "gpt-5.6-terra",
    },
    "turn/start": { turn: { id: "turn-1" } },
    "turn/steer": {},
    "turn/interrupt": {},
  }) satisfies Readonly<Record<string, Schema.Json>>;

/** A Codex `userMessage` item that records `text`. */
export const userMessage = (id: string, text: string) => ({
  type: "userMessage",
  id,
  content: [{ type: "text", text, text_elements: [] }],
});
