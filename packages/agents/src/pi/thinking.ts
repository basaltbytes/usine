import { Agent } from "@usine/core";

export interface ThinkingCapableModel {
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Partial<Record<Agent.Effort, string | null>> | undefined;
}

/** Pi's own support rule, which the SDK applies by clamping instead of exposing. */
export const supportedThinkingLevels = (
  model: ThinkingCapableModel,
): ReadonlyArray<Agent.Effort> => {
  if (!model.reasoning) return ["off"];
  return Agent.EFFORTS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
};
