import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { BLOCKED_MARKER, QUESTION_MARKER } from "@usine/agents/runtime";
import type { ExtensionServices } from "./services.ts";
import { subagentTool } from "./subagent.ts";
import { attemptTask } from "./task.ts";

/** The extension's name, stored by every parent conversation that selects it. */
const USINE_EXTENSION = "usine";

const parentGuidance = [
  "You coordinate one usine Attempt. Your only tool is `subagent`: it delegates one focused task to a child agent working in the Attempt's checkout and returns the child's report.",
  "- Delegate only independent, focused work; the child cannot create more children.",
  `- When a child's report starts with ${BLOCKED_MARKER} or ${QUESTION_MARKER}, return that report verbatim as your own final answer instead of summarising it.`,
  "- A `subagent` call that ends as interrupted is not a blocker: the orchestrator restarted and the checkout keeps everything the child did. Delegate again with a task that tells the child to inspect the checkout and continue from its current state.",
  "- The operator can write to you while you work; a message sent during a delegation reaches you when the delegation returns. Treat it as part of this task. Answer a question and end your turn: the operator then replies or releases you to continue. Follow guidance and keep working. A reply to the operator is never the task's final answer; give the final answer only when the task is done or blocked.",
].join("\n");

/**
 * The usine extension: the `usine.attempt` task, the `subagent` tool, and the
 * parent's guidance section. Parent conversations select it and its tool by
 * name, so a restarted process resumes them once it installs the extension.
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
