import type { BillingPool, PoolDescriptor } from "@usine/core/agent/pool";
import { chatgptPlan } from "../codex/descriptor.ts";
import { apiKeys } from "../pool.ts";

/** A Pi credential category; OAuth credentials also record whether the provider identifies a subscription. */
export type PiAuthentication =
  | {
      /** The provider uses an API key. */
      readonly _tag: "ApiKey";
    }
  | {
      /** The provider uses an OAuth login. */
      readonly _tag: "OAuth";
      /** Whether the provider identifies the login as a subscription credential. */
      readonly subscription: boolean;
    };
/**
 * The plan pool of each Pi subscription login that usine accepts, by Pi provider. Pi refuses the
 * other logins, whose billing no pool states.
 */
export const piLoginPools: ReadonlyMap<string, PoolDescriptor> = new Map([
  ["openai-codex", chatgptPlan],
]);

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
export const requiredPiPool = (provider: string): BillingPool =>
  (piLoginPools.get(provider) ?? apiKeys).id;

/** Returns the billing pool of the credential used for the model request, or `undefined` if it is neither an API key nor a subscription login in `piLoginPools`. */
export const resolvePiPool = (
  provider: string,
  authentication: PiAuthentication | undefined,
): BillingPool | undefined => {
  if (authentication?._tag === "ApiKey") return apiKeys.id;
  if (authentication?._tag === "OAuth" && authentication.subscription)
    return piLoginPools.get(provider)?.id;
  return undefined;
};
