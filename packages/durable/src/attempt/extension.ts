import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import {
  BLOCKED_MARKER,
  CAPACITY_MARKER,
  FAILED_MARKER,
  QUESTION_MARKER,
} from "@usine/agents/runtime";
import type { ExtensionServices } from "./services.ts";
import { subagentTool } from "./subagent.ts";
import { attemptTask } from "./task.ts";

/** The extension name, stored in every parent conversation that selects it. */
const USINE_EXTENSION = "usine";

const parentGuidance = [
  "You coordinate one usine Attempt. Your only tool is `subagent`: it delegates one focused task to a child agent working in the Attempt's checkout and returns the child's report.",
  "- Every child receives the rendered loop task unchanged. Use the subagent task argument for supplemental context or a focused assignment within that task; do not rewrite its requirements. The child cannot create more children.",
  `- When a child's report starts with ${BLOCKED_MARKER}, ${QUESTION_MARKER}, ${CAPACITY_MARKER}, or ${FAILED_MARKER}, return that report verbatim as your own final answer instead of summarising it.`,
  "- A `subagent` call that ends as interrupted is not a blocker: the orchestrator restarted and the checkout keeps everything the child did. Delegate again with a task that tells the child to inspect the checkout and continue from its current state.",
  "- The operator can write to you while you work; a message sent during a delegation reaches you when the delegation returns. Treat it as part of this task. Answer a question and end your turn: the operator then replies or releases you to continue. Follow guidance and keep working. A reply to the operator is never the task's final answer; give the final answer only when the task is done or blocked.",
  "- Operator steers are forwarded to your single live child. If a steer could not be delivered, you get a separate turn with the guidance. Act on it by delegating the remaining work or answering the operator before your final answer; do not relay the previous child's result unchanged.",
].join("\n");

/**
 * Returns the usine extension: the `usine.attempt` task, the `subagent` tool, and the parent's
 * guidance section.
 */
export const usineExtension = (services: ExtensionServices) => {
  const tool = subagentTool(services);
  let extension: Extension | undefined;
  const task = attemptTask(services, () => {
    if (extension === undefined) throw new Error("The usine extension is not built yet");
    return { extension, tool };
  });
  extension = defineExtension({
    name: USINE_EXTENSION,
    tools: [tool],
    sections: [section(USINE_EXTENSION, () => parentGuidance, { tag: false })],
    tasks: [task],
  });
  return { extension, task };
};
