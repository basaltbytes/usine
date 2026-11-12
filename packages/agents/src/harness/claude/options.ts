import type { SessionSpec } from "../contract.ts";
import type { ClaudeQueryOptions } from "./sdk.ts";

/** The options that select the brain, checkout, and environment of every Claude Code launch. */
export const brainOptions = (
  spec: SessionSpec,
): Pick<
  ClaudeQueryOptions,
  "cwd" | "effort" | "env" | "model" | "pathToClaudeCodeExecutable" | "settingSources" | "thinking"
> => {
  const effort = spec.session.brain.effort;
  const shared: Pick<
    ClaudeQueryOptions,
    "cwd" | "env" | "model" | "pathToClaudeCodeExecutable" | "settingSources"
  > = {
    cwd: spec.cwd,
    // Replaces the subprocess environment instead of extending this process's.
    env: { ...spec.environment },
    model: spec.session.brain.model,
    // The Worker-provisioned binary that the readiness checks inspect.
    pathToClaudeCodeExecutable: "claude",
    // The worktree is untrusted, so its project and local settings (hooks, env) are not loaded into
    // a child that has the App credential; only the Worker user's settings apply.
    settingSources: ["user"],
  };
  return effort === "off"
    ? { ...shared, thinking: { type: "disabled" } }
    : {
        ...shared,
        effort: effort === "minimal" ? "low" : effort,
        thinking: { type: "adaptive" },
      };
};
