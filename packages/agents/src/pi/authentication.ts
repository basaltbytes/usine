import type { Agent } from "@usine/core";

export type PiAuthentication = "apiKey" | "oauth" | "subscription";
export type PiPool = Extract<Agent.Pool, "apiKeys" | "chatgptPlan">;

/** Resolve Pi's billing source from the credential that will spend the model request. */
export const resolvePiPool = (
  provider: string,
  authentication: PiAuthentication,
): PiPool | undefined => {
  if (authentication === "apiKey") return "apiKeys";
  if (authentication === "subscription" && provider === "openai-codex") {
    return "chatgptPlan";
  }
  return undefined;
};
