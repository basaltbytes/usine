import type { BillingPool } from "@usine/core/agent/session";

export type PiAuthentication =
  | { readonly _tag: "ApiKey" }
  | { readonly _tag: "OAuth"; readonly subscription: boolean };
export type PiPool = Extract<BillingPool, "apiKeys" | "chatgptPlan">;

/** The billing pool the chosen Pi provider spends from, checked before launch. */
export const requiredPiPool = (provider: string): PiPool =>
  provider === "openai-codex" ? "chatgptPlan" : "apiKeys";

/** Returns the billing pool of the credential that pays for the model request. */
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
