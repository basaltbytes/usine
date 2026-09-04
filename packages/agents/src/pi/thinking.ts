import { Effort, EFFORTS } from "@usine/core/agent/brain";

export interface ThinkingCapableModel {
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Partial<Record<Effort, string | null>> | undefined;
}

/** The thinking levels a model supports; the SDK clamps to this set without exposing it. */
export const supportedThinkingLevels = (model: ThinkingCapableModel): ReadonlyArray<Effort> => {
  if (!model.reasoning) return ["off"];
  return EFFORTS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
};
