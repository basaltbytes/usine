import type { BillingPool } from "@usine/core/agent/session";

export type PiAuthentication =
  | { readonly _tag: "ApiKey" }
  | { readonly _tag: "OAuth"; readonly subscription: boolean };
export type PiPool = Extract<BillingPool, "apiKeys" | "chatgptPlan">;

/** Billing pool the selected Pi provider must have available before launch. */
export const requiredPiPool = (provider: string): PiPool =>
  provider === "openai-codex" ? "chatgptPlan" : "apiKeys";

/** Resolve Pi's billing source from the credential that will spend the model request. */
export const resolvePiPool = (
  provider: string,
  authentication: PiAuthentication | undefined,
): PiPool | undefined => {
  if (authentication?._tag === "ApiKey") return "apiKeys";
  if (
    authentication?._tag === "OAuth" &&
    authentication.subscription &&
    provider === "openai-codex"
  ) {
    return "chatgptPlan";
  }
  return undefined;
};
