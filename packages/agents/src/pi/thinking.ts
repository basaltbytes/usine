import { Effort, EFFORTS } from "@usine/core/agent/brain";

export interface ThinkingCapableModel {
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Partial<Record<Effort, string | null>> | undefined;
}

/** Pi's own support rule, which the SDK applies by clamping instead of exposing. */
export const supportedThinkingLevels = (model: ThinkingCapableModel): ReadonlyArray<Effort> => {
  if (!model.reasoning) return ["off"];
  return EFFORTS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
};
