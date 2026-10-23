import type { GatewayDomain } from "@usine/core/worker";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import type { EgressAllowlist } from "./egress/egress.ts";
import type { GitHubOrigins } from "./github/github.ts";
import type { LlmProviders } from "./llm/llm.ts";

/** The HMAC key that signs caller tokens, at least 32 characters, known only to the Gateway. */
export const CallerKey = Schema.RedactedFromValue(
  Schema.String.check(
    Schema.isMinLength(32, { message: "Expected a caller key of at least 32 characters" }),
  ),
);
export type CallerKey = typeof CallerKey.Type;

/** The bearer token the executor sends to the admin API, at least 32 characters. */
export const AdminToken = Schema.RedactedFromValue(
  Schema.String.check(
    Schema.isMinLength(32, { message: "Expected an admin token of at least 32 characters" }),
  ),
);
export type AdminToken = typeof AdminToken.Type;

/**
 * The Gateway's configuration as read at startup. Secrets stay `Redacted` until sent or used to
 * sign. `egress` and `providers` keep their startup values; reloaded values are in
 * `SettingsInForce`. Other settings change only with a restart.
 */
export class GatewaySettings extends Context.Service<
  GatewaySettings,
  {
    readonly domain: GatewayDomain;
    readonly github: GitHubOrigins;
    readonly providers: LlmProviders;
    readonly egress: EgressAllowlist;
    readonly adminToken: AdminToken;
    readonly callerKey: CallerKey;
  }
>()("@usine/gateway/GatewaySettings") {}

/** The settings a reload replaces: the egress allowlist and LLM providers. */
export interface ReloadableSettings {
  readonly egress: EgressAllowlist;
  readonly providers: LlmProviders;
}

/**
 * The current egress allowlist and LLM providers, initially from `GatewaySettings` and
 * replaced by each reload. A request reads them once, so a tunnel opened under the previous
 * allowlist stays open.
 */
export class SettingsInForce extends Context.Service<
  SettingsInForce,
  {
    /** Returns the current allowlist and providers. */
    readonly current: Effect.Effect<ReloadableSettings>;
    /** Replaces them for all later requests. */
    readonly replace: (next: ReloadableSettings) => Effect.Effect<void>;
  }
>()("@usine/gateway/SettingsInForce") {
  static readonly layer = Layer.effect(
    SettingsInForce,
    Effect.gen(function* () {
      const { egress, providers } = yield* GatewaySettings;
      const inForce = yield* Ref.make<ReloadableSettings>({ egress, providers });
      return { current: Ref.get(inForce), replace: (next) => Ref.set(inForce, next) };
    }),
  );
}

/** Returns the host names the Gateway serves under `domain`. */
export const gatewayHosts = (domain: GatewayDomain) =>
  ({ git: `git.${domain}`, llm: `llm.${domain}` }) as const;
