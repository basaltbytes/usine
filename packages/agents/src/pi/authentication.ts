import type { BillingPool } from "@usine/core/agent/session";

export type PiAuthentication =
  | { readonly _tag: "ApiKey" }
  | { readonly _tag: "OAuth"; readonly subscription: boolean };
export type PiPool = Extract<BillingPool, "apiKeys" | "chatgptPlan">;

/** The provider and model id of a `provider/model` name, the provider deciding the credential; undefined unless both parts are present. */
export const splitPiModel = (
  model: string,
): { readonly provider: string; readonly modelId: string } | undefined => {
  const separator = model.indexOf("/");
  return separator <= 0 || separator === model.length - 1
    ? undefined
    : { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
};

/** Pi's credential check for a provider as the pool decision reads it; `subscription` tells whether its OAuth login is a subscription. */
export const piAuthentication = (
  check: { readonly type: "api_key" | "oauth" } | undefined,
  subscription: boolean,
): PiAuthentication | undefined =>
  check?.type === "api_key"
    ? { _tag: "ApiKey" }
    : check?.type === "oauth"
      ? { _tag: "OAuth", subscription }
      : undefined;

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
