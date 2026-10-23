import type { BillingPool } from "@usine/core/agent/session";

export type PiAuthentication =
  | { readonly _tag: "ApiKey" }
  | { readonly _tag: "OAuth"; readonly subscription: boolean };
export type PiPool = Extract<BillingPool, "apiKeys" | "chatgptPlan">;

/** Splits `provider/model` into provider and model ID; `undefined` unless both parts are present. */
export const splitPiModel = (
  model: string,
): { readonly provider: string; readonly modelId: string } | undefined => {
  const separator = model.indexOf("/");
  return separator <= 0 || separator === model.length - 1
    ? undefined
    : { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
};

/** Converts Pi's credential check, with `subscription` set if the OAuth login is a subscription; returns `undefined` if Pi found no credential. */
export const piAuthentication = (
  check: { readonly type: "api_key" | "oauth" } | undefined,
  subscription: boolean,
): PiAuthentication | undefined =>
  check?.type === "api_key"
    ? { _tag: "ApiKey" }
    : check?.type === "oauth"
      ? { _tag: "OAuth", subscription }
      : undefined;

/** Returns the billing pool that a Pi provider requires; checked before launch. */
export const requiredPiPool = (provider: string): PiPool =>
  provider === "openai-codex" ? "chatgptPlan" : "apiKeys";

/** Returns the billing pool of the credential used for the model request, or `undefined` if it is neither an API key nor a subscription login to `openai-codex`. */
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
